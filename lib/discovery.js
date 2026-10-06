/**
 * mDNS advertisement, so the phone finds the desktop without being told an IP.
 *
 * A minimal responder rather than a full mDNS stack: it answers queries for its
 * own service instance and nothing else. That is all a phone browsing for
 * `_dsh-mobile-connect._tcp` needs, and it keeps the plugin dependency-free.
 *
 * Every failure here is non-fatal. Discovery is a convenience; if multicast is
 * unavailable (common on locked-down corporate networks) the user can still
 * type the address the plugin printed.
 */
import dgram from 'node:dgram'

const MULTICAST_ADDRESS = '224.0.0.251'
const MDNS_PORT = 5353
/**
 * Service type advertised for discovery.
 *
 * KNOWN DEVIATION: RFC 6763 §7 asks that a Service Name be at most 15
 * characters (not counting the leading underscore); `dsh-mobile-connect` is 18.
 * §7.2 explains the limit exists to conserve bytes, not because the wire format
 * forbids longer labels — DNS allows 63 octets, so the announcement above is
 * well-formed and decodable (the project's terminal/decoder tests confirm it).
 * The practical risk is that a strict DNS-SD implementation may refuse to
 * browse an over-long type.
 *
 * This value is a contract with the phone: DSH Mobile browses exactly this
 * string. Shortening it here without changing the app would silently break
 * discovery altogether, which is worse than the deviation. If it is ever made
 * compliant, both sides must move together — and TXT `v=1` is the place to
 * negotiate that.
 */
const SERVICE = '_dsh-mobile-connect._tcp.local'
/** Re-announce twice, per the mDNS spec's unsolicited-response guidance. */
const ANNOUNCE_DELAYS_MS = [0, 1000]
const PTR = 12
const TXT = 16
const SRV = 33
const A = 1
const CLASS_IN = 1
/** Top bit of the class field: "this record is authoritative, flush caches". */
const CACHE_FLUSH = 0x8000

/** Encode a dotted DNS name as length-prefixed labels. */
function encodeName(name) {
  const parts = name.split('.').filter((p) => p.length > 0)
  const chunks = []
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf8')
    chunks.push(Buffer.from([bytes.length]), bytes)
  }
  chunks.push(Buffer.from([0]))
  return Buffer.concat(chunks)
}

/** Build one resource record. */
function record(name, type, rdata, { ttl = 120, flush = false } = {}) {
  const header = Buffer.alloc(10)
  header.writeUInt16BE(type, 0)
  header.writeUInt16BE(CLASS_IN | (flush ? CACHE_FLUSH : 0), 2)
  header.writeUInt32BE(ttl, 4)
  header.writeUInt16BE(rdata.length, 8)
  return Buffer.concat([encodeName(name), header, rdata])
}

/** Read a DNS name from `buf` at `offset`, following compression pointers. */
function readName(buf, offset) {
  const labels = []
  let cursor = offset
  let guard = 0
  while (cursor < buf.length && guard < 128) {
    guard += 1
    const length = buf[cursor]
    if (length === 0) {
      cursor += 1
      break
    }
    if ((length & 0xc0) === 0xc0) {
      // Compression pointer: the rest of this name lives elsewhere.
      if (cursor + 1 >= buf.length) break
      const target = ((length & 0x3f) << 8) | buf[cursor + 1]
      if (target >= offset) break // only backwards pointers are legal
      const nested = readName(buf, target)
      labels.push(...nested.labels)
      cursor += 2
      return { labels, end: cursor }
    }
    const start = cursor + 1
    labels.push(buf.subarray(start, start + length).toString('utf8'))
    cursor = start + length
  }
  return { labels, end: cursor }
}

/**
 * Advertise the gateway over mDNS.
 *
 * The returned handle is inert when the socket cannot be opened, so callers
 * never have to branch on whether discovery is available.
 */
export class Discovery {
  #socket
  #instance
  #hostname
  #port
  #address
  #log
  #timers = []
  #closed = false

  constructor({ port, address, log, instanceName = 'DSH Harness' }) {
    // A missing address is a caller error, but it arrives from network state
    // the caller does not control (Wi-Fi down, IPv6-only, laptop resumed
    // off-network), and an mDNS responder is a convenience — never a reason to
    // take the process down. Refuse loudly with a clear message instead of
    // letting `.split` throw a TypeError the caller cannot interpret.
    if (typeof address !== 'string' || address.trim() === '') {
      throw new Error(
        'Discovery: address must be a non-empty IPv4 string (no LAN address is available)',
      )
    }
    this.#port = port
    this.#address = address
    this.#log = log
    // mDNS instance names are free-form; the host label must be DNS-safe.
    this.#instance = `${instanceName}.${SERVICE}`
    // The SRV target derived from the last two octets, e.g. `dsh-1-5.local`.
    // Good enough to be memorable, but NOT unique: 192.168.1.5, 10.0.1.5 and
    // 172.16.1.5 all yield the same name, and RFC 6762 §9 expects a responder
    // to probe for uniqueness before claiming a host name. We announce without
    // probing, so on a network where two such machines coincide the A record is
    // ambiguous. In practice the phone resolves the service via SRV/TXT and the
    // address is also carried in the pairing info, so this is a cosmetic
    // ambiguity rather than a failure to connect.
    const suffix = address.split('.').slice(-2).join('-')
    this.#hostname = `dsh-${suffix}.local`
  }

  /** Start listening for queries and announce ourselves. */
  async start() {
    try {
      this.#socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })

      this.#socket.on('error', (error) => {
        this.#log?.warn?.(`[dsh-mobile-connect] 局域网自动发现不可用：${error?.message ?? error}`)
        this.#teardown()
      })
      this.#socket.on('message', (msg, rinfo) => this.#onMessage(msg, rinfo))

      await new Promise((resolve, reject) => {
        const onError = (error) => reject(error)
        this.#socket.once('error', onError)
        this.#socket.bind(MDNS_PORT, () => {
          this.#socket.off('error', onError)
          resolve()
        })
      })

      try {
        this.#socket.addMembership(MULTICAST_ADDRESS)
      } catch (error) {
        // Another process may already hold the group; we can still answer
        // unicast queries, so this is not fatal.
        this.#log?.warn?.(`[dsh-mobile-connect] 加入组播组失败：${error?.message ?? error}`)
      }
      this.#socket.setMulticastTTL(255)
      this.#socket.setMulticastLoopback(true)

      for (const delay of ANNOUNCE_DELAYS_MS) {
        const timer = setTimeout(() => this.#announce(), delay)
        timer.unref?.()
        this.#timers.push(timer)
      }
      return true
    } catch (error) {
      this.#log?.warn?.(
        `[dsh-mobile-connect] 局域网自动发现未启用：${error?.message ?? error}。可以在手机上手动输入地址。`,
      )
      this.#teardown()
      return false
    }
  }

  /** The records describing this service instance. */
  #records(ttl) {
    const srvData = Buffer.alloc(6)
    srvData.writeUInt16BE(0, 0) // priority
    srvData.writeUInt16BE(0, 2) // weight
    srvData.writeUInt16BE(this.#port, 4)
    const srv = Buffer.concat([srvData, encodeName(this.#hostname)])

    // TXT: one key=value per string, which is how resolvers expose them.
    const txtParts = ['v=1', `name=${this.#instance.split('.')[0]}`].map((s) => {
      const bytes = Buffer.from(s, 'utf8')
      return Buffer.concat([Buffer.from([bytes.length]), bytes])
    })
    const txt = Buffer.concat(txtParts)

    const a = Buffer.from(this.#address.split('.').map((n) => Number(n) & 0xff))

    return [
      record(SERVICE, PTR, encodeName(this.#instance), { ttl }),
      record(this.#instance, SRV, srv, { ttl, flush: true }),
      record(this.#instance, TXT, txt, { ttl, flush: true }),
      record(this.#hostname, A, a, { ttl, flush: true }),
    ]
  }

  /** Send an unsolicited response (an "announcement"). */
  #announce(ttl = 120) {
    if (this.#socket === undefined || this.#closed) return
    try {
      const answers = this.#records(ttl)
      const header = Buffer.alloc(12)
      header.writeUInt16BE(0, 0) // id 0 for unsolicited
      header.writeUInt16BE(0x8400, 2) // response + authoritative
      header.writeUInt16BE(answers.length, 6) // ANCOUNT
      const packet = Buffer.concat([header, ...answers])
      this.#socket.send(packet, 0, packet.length, MDNS_PORT, MULTICAST_ADDRESS, () => {})
    } catch {
      // A failed announcement is not worth reporting; the next one may land.
    }
  }

  /**
   * Re-announce, refreshing peers' caches.
   *
   * mDNS records expire, so a long-running desktop has to keep saying it is
   * still here or the phone's discovery list will quietly empty.
   */
  reannounce() {
    this.#announce()
  }

  /** Answer a query that asks for our service. */
  #onMessage(msg, rinfo) {
    if (this.#closed || msg.length < 12) return
    try {
      const qdcount = msg.readUInt16BE(4)
      if (qdcount === 0) return
      const flags = msg.readUInt16BE(2)
      if ((flags & 0x8000) !== 0) return // a response, not a query

      let offset = 12
      let wantsUs = false
      for (let i = 0; i < qdcount && offset < msg.length; i += 1) {
        const { labels, end } = readName(msg, offset)
        offset = end + 4 // skip QTYPE + QCLASS
        const name = labels.join('.').toLowerCase()
        if (name === SERVICE.toLowerCase() || name.endsWith(`.${SERVICE.toLowerCase()}`)) {
          wantsUs = true
        }
      }
      if (!wantsUs) return

      const answers = this.#records(120)
      const header = Buffer.alloc(12)
      header.writeUInt16BE(0, 0)
      header.writeUInt16BE(0x8400, 2)
      header.writeUInt16BE(answers.length, 6)
      const packet = Buffer.concat([header, ...answers])
      // Reply from the mDNS port so the querier accepts it as authoritative.
      this.#socket.send(packet, 0, packet.length, MDNS_PORT, rinfo.address, () => {})
    } catch {
      // Malformed queries are ignored rather than logged: on a busy network
      // they are constant background noise.
    }
  }

  /** Send a goodbye (TTL 0) so peers drop us immediately. */
  #goodbye() {
    if (this.#socket === undefined) return
    try {
      const answers = this.#records(0)
      const header = Buffer.alloc(12)
      header.writeUInt16BE(0, 0)
      header.writeUInt16BE(0x8400, 2)
      header.writeUInt16BE(answers.length, 6)
      const packet = Buffer.concat([header, ...answers])
      this.#socket.send(packet, 0, packet.length, MDNS_PORT, MULTICAST_ADDRESS, () => {})
    } catch {
      // Shutting down anyway.
    }
  }

  #teardown() {
    try {
      this.#socket?.close()
    } catch {
      // Already closed.
    }
    this.#socket = undefined
  }

  /** Announce a goodbye and release the socket. */
  close() {
    if (this.#closed) return
    this.#closed = true
    for (const timer of this.#timers) clearTimeout(timer)
    this.#timers = []
    this.#goodbye()
    this.#teardown()
  }
}
