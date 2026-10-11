import { isIP } from 'node:net';

export async function androidHostAddresses(signal, token = process.env.DSH_ANDROID_BRIDGE_TOKEN, fetcher = fetch) {
  if (!token) return undefined;
  const response = await fetcher('http://127.0.0.1:3981/rpc', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-token': token },
    body: JSON.stringify({ method: 'peerNetworkAddresses' }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error('Android network address lookup failed');
  const value = await response.json();
  const addresses = Array.isArray(value.addresses) ? [...new Set(value.addresses.filter(address => typeof address === 'string' && isIP(address)))] : [];
  if (!addresses.length) throw new Error('Android has no active network. Connect Wi-Fi or mobile data first.');
  return addresses;
}
