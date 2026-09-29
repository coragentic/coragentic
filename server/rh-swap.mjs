import { createPublicClient, encodeFunctionData, erc20Abi, formatUnits, http, isAddress, parseUnits } from 'viem';

export const CHAIN_ID = 4663;
export const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
export const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
export const ROUTER = '0xcaf681a66d020601342297493863e78c959e5cb2';
export const QUOTERV2 = '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7';
export const DEFAULT_RPC_URL = process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';

const FEES = [100, 500, 3000, 10000];
const HOPS = [[100, 500], [500, 500], [100, 100], [500, 3000], [3000, 500]];
const QUOTER_ABI = [{
  name: 'quoteExactInput', type: 'function', stateMutability: 'nonpayable',
  inputs: [{ name: 'path', type: 'bytes' }, { name: 'amountIn', type: 'uint256' }],
  outputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'sqrtPriceX96AfterList', type: 'uint160[]' }, { name: 'initializedTicksCrossedList', type: 'uint32[]' }, { name: 'gasEstimate', type: 'uint256' }],
}];
const ROUTER_ABI = [
  { name: 'exactInput', type: 'function', stateMutability: 'payable', inputs: [{ name: 'params', type: 'tuple', components: [{ name: 'path', type: 'bytes' }, { name: 'recipient', type: 'address' }, { name: 'amountIn', type: 'uint256' }, { name: 'amountOutMinimum', type: 'uint256' }] }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'multicall', type: 'function', stateMutability: 'payable', inputs: [{ name: 'data', type: 'bytes[]' }], outputs: [{ name: 'results', type: 'bytes[]' }] },
  { name: 'refundETH', type: 'function', stateMutability: 'payable', inputs: [], outputs: [] },
];
const CHAIN = { id: CHAIN_ID, name: 'Robinhood Chain', nativeCurrency: { name: 'Robinhood Chain Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [DEFAULT_RPC_URL] } } };

export function createRobinhoodPublicClient({ rpcUrl = DEFAULT_RPC_URL, transport } = {}) {
  return createPublicClient({ chain: { ...CHAIN, rpcUrls: { default: { http: [rpcUrl] } } }, transport: transport || http(rpcUrl) });
}

export function noCustodyMessage() { return 'MCP does not custody private keys and never broadcasts transactions; sign and submit unsigned calldata with an explicit wallet. '; }

export function validateSwapInput({ token, amount, amountDecimals = 18 }) {
  if (typeof token !== 'string' || !isAddress(token)) throw new Error('invalid token address');
  if (typeof amount !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(amount) || Number(amount) <= 0) throw new Error('invalid amount');
  if (!Number.isInteger(amountDecimals) || amountDecimals < 0 || amountDecimals > 255) throw new Error('invalid amount decimals');
  return { token, amount, amountDecimals };
}

export function encodePath(tokens, fees) {
  let path = tokens[0].slice(2).toLowerCase();
  for (let i = 0; i < fees.length; i += 1) path += fees[i].toString(16).padStart(6, '0') + tokens[i + 1].slice(2).toLowerCase();
  return `0x${path}`;
}

export function candidateRoutes(token) {
  const routes = [];
  for (const [a, b] of HOPS) routes.push({ path: encodePath([WETH, USDG, token], [a, b]), route: `WETH/${a}/USDG/${b}` });
  for (const fee of FEES) routes.push({ path: encodePath([WETH, token], [fee]), route: `WETH/${fee}` });
  return routes;
}

function requireClient(client) {
  if (!client || typeof client.readContract !== 'function') throw new Error('public client is required');
  return client;
}

export async function quoteSwap(input, { client = createRobinhoodPublicClient(), tokenDecimals } = {}) {
  const { token, amount, amountDecimals } = validateSwapInput(input);
  const publicClient = requireClient(client);
  const decimals = tokenDecimals ?? await publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' });
  const amountIn = parseUnits(amount, amountDecimals);
  let best = null;
  for (const candidate of candidateRoutes(token)) {
    try {
      const result = await publicClient.readContract({ address: QUOTERV2, abi: QUOTER_ABI, functionName: 'quoteExactInput', args: [candidate.path, amountIn] });
      if (result?.[0] > 0n && (!best || result[0] > best.amountOut)) best = { ...candidate, amountOut: result[0], gasEstimate: result[3] || 0n };
    } catch { /* candidate pool may not exist */ }
  }
  if (!best) throw new Error('no viable Robinhood Chain swap route');
  const slippageBps = input.slippageBps === undefined ? 50 : Number(input.slippageBps);
  // Cap at 2000bps (20%): a wide but still meaningful bound. 10000bps (100%)
  // would authorize amountOutMinimum = 0 -- unsigned calldata accepting any
  // output, including zero, which is unsafe for a non-custodial product to
  // hand a wallet to sign.
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 2_000) throw new Error('invalid slippage bps');
  const minimumOut = best.amountOut * BigInt(10_000 - slippageBps) / 10_000n;
  return { chainId: CHAIN_ID, tokenIn: WETH, tokenOut: token, amountIn: amountIn.toString(), amountOut: best.amountOut.toString(), amountOutFormatted: formatUnits(best.amountOut, decimals), minimumOut: minimumOut.toString(), slippageBps, route: best.route, path: best.path, gasEstimate: best.gasEstimate.toString(), decimals: Number(decimals) };
}

export async function previewSwap(input, { client = createRobinhoodPublicClient(), wallet, tokenDecimals } = {}) {
  if (!wallet || !isAddress(wallet)) throw new Error('wallet address is required');
  const quote = await quoteSwap(input, { client, tokenDecimals });
  const swap = encodeFunctionData({ abi: ROUTER_ABI, functionName: 'exactInput', args: [{ path: quote.path, recipient: wallet, amountIn: BigInt(quote.amountIn), amountOutMinimum: BigInt(quote.minimumOut) }] });
  const data = encodeFunctionData({ abi: ROUTER_ABI, functionName: 'multicall', args: [[swap, encodeFunctionData({ abi: ROUTER_ABI, functionName: 'refundETH' })]] });
  return { ...quote, unsigned: true, custody: 'external_wallet_required', to: ROUTER, value: quote.amountIn, data, warning: noCustodyMessage() };
}

export async function swapStatus(txHash, { rpcUrl = DEFAULT_RPC_URL, fetchImpl = fetch } = {}) {
  if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error('invalid transaction hash');
  const response = await fetchImpl(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash] }), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`RPC returned ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(body.error.message || 'RPC error');
  return { chainId: CHAIN_ID, txHash, status: body.result ? (body.result.status === '0x1' ? 'confirmed' : 'failed') : 'pending', receipt: body.result || null, source: 'rpc' };
}
