const dns = require('node:dns')
const http = require('node:http')
const { isIP } = require('node:net')

function systemLookup(hostname) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ method: 'resolveHost', hostname })
    const request = http.request({
      hostname: '127.0.0.1', port: 3981, path: '/rpc', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
        'x-bridge-token': process.env.DSH_ANDROID_BRIDGE_TOKEN },
    }, response => {
      let data = ''
      response.setEncoding('utf8')
      response.on('data', chunk => {
        data += chunk
        if (data.length > 16384) request.destroy(new Error('Android DNS response too large'))
      })
      response.on('error', reject)
      response.on('end', () => {
        try {
          const result = JSON.parse(data)
          if (response.statusCode !== 200 || !Array.isArray(result.addresses) || !result.addresses.length)
            throw new Error(result.error || 'Android DNS returned no addresses')
          resolve(result.addresses)
        } catch (error) { reject(error) }
      })
    })
    request.setTimeout(8000, () => request.destroy(new Error('Android DNS bridge timed out')))
    request.on('error', reject)
    request.end(body)
  })
}

exports.install = function (resolveSystem = systemLookup) {
  const original = dns.lookup
  dns.lookup = function (hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {} }
    if (typeof callback !== 'function') return original.apply(this, arguments)
    return original.call(this, hostname, options, (error, address, family) => {
      if (!error || !['ENOTFOUND', 'EAI_AGAIN'].includes(error.code)) return callback(error, address, family)
      resolveSystem(hostname).then(addresses => {
        const requested = typeof options === 'number' ? options : options?.family
        const targetFamily = requested === 'IPv4' ? 4 : requested === 'IPv6' ? 6 : requested
        const selected = addresses.filter(item => (!targetFamily || targetFamily === item.family)
          && isIP(item.address) === item.family)
        const order = options?.order ?? (options?.verbatim === false ? 'ipv4first' : dns.getDefaultResultOrder())
        if (order === 'ipv4first') selected.sort((a, b) => a.family - b.family)
        if (order === 'ipv6first') selected.sort((a, b) => b.family - a.family)
        if (!selected.length) return callback(error)
        if (options?.all) callback(null, selected)
        else callback(null, selected[0].address, selected[0].family)
      }, () => callback(error))
    })
  }
  // WebRTC's STUN/TURN lookup uses the promise API. It must use the same
  // Android resolver fallback as WebSocket and other callback consumers.
  dns.promises.lookup = (hostname, options = {}) => new Promise((resolve, reject) => {
    dns.lookup(hostname, options, (error, address, family) => {
      if (error) reject(error)
      else resolve(options?.all ? address : { address, family })
    })
  })
  require('node:module').syncBuiltinESMExports()
}
