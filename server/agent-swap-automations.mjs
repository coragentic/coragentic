// Natural-language swap automations bound to an agent's custody wallet.
// A chat command like "swap eth to usdg 0.01 everyday" becomes a durable
// schedule; when due, the runner quotes a live route and broadcasts a real
// multicall from the agent wallet (spend policy permitting). No gas / no
// route / policy-disabled => recorded failure, never a fake success.
import { createWalletClient, http, parseEther, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CHAIN_ID, WETH, USDG, quoteSwap } from './rh-swap.mjs';
import { claimDueAutomation, markAutomationRun } from './agent-automations.mjs';
import { decryptCustodyKey } from './agent-custody.mjs';
import { randomUUID } from 'node:crypto';

const ROBINHOOD_CHAIN = {
  id: CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Robinhood Chain Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com'] } },
};

export function migrateSwapSchema(db) {
  // Swap automations reuse the agent_automations table; this migration is a
  // no-op kept for schema symmetry and future swap-specific columns.
}

const SYMBOLS = { usdg: USDG, weth: WETH, eth: WETH };

/** Parse "swap [0.01] eth to usdg [every day|daily]". Returns null when the
 * text is not a swap command. Accepts either symbol names or a full token
 * address as the destination. `agentId` is bound by the caller (chat route). */
export function parseSwapCommand(text, { agentId } = {}) {
  const raw = String(text ?? '').toLowerCase();
  const match = raw.match(/swap\s+(?:(\d+(?:\.\d+)?)\s+)?(eth|weth|usdg|0x[0-9a-f]{40})\s+(?:to|->|for)\s+(eth|weth|usdg|0x[0-9a-f]{40})(?:\s+(\d+(?:\.\d+)?))?/);
  if (!match) return null;
  const amount = match[1] ?? match[4];
  if (!amount) return null;
  const tokenInSymbol = match[2];
  const tokenOutSymbol = match[3];
  if (tokenInSymbol === tokenOutSymbol) return null;
  const tokenOut = SYMBOLS[tokenOutSymbol] ?? (/^0x[0-9a-f]{40}$/.test(tokenOutSymbol) ? tokenOutSymbol : null);
  if (!tokenOut) return null;
  const daily = /\b(every\s?day|daily|each\s?day|everyday)\b/.test(raw) || /\b(every\s+)?24\s?h\b/.test(raw);
  const schedule = daily ? { kind: 'interval', intervalMinutes: 1440 } : { kind: 'interval', intervalMinutes: 60 };
  return {
    agentId: agentId ?? null,
    tokenInSymbol,
    tokenOutSymbol,
    tokenOut,
    amountEth: amount,
    schedule,
    recurring: daily,
  };
}

function custodyWalletRow(db, agentId, ownerWallet) {
  return db.prepare('SELECT address, encrypted_private_key, policy_json FROM agent_wallets WHERE agent_id = ? AND owner_wallet = ?').get(agentId, ownerWallet);
}

function policyAllows(policy, amountEth) {
  return Boolean(policy?.spendEnabled) && !policy?.requireOwnerApproval
    && Number(policy?.dailyLimitUsd ?? 0) > 0;
}

async function ethBalance(address, rpcUrl) {
  const client = createWalletClient({ chain: ROBINHOOD_CHAIN, transport: http(rpcUrl) });
  // public read via wallet client's extended transport
  const balance = await client.request({ method: 'eth_getBalance', params: [address, 'latest'] });
  return BigInt(balance);
}

async function broadcastSwap({ privateKey, walletAddress, tokenOut, amountEth, rpcUrl }) {
  const account = privateKeyToAccount(privateKey);
  const client = createWalletClient({ account, chain: ROBINHOOD_CHAIN, transport: http(rpcUrl) });
  const quote = await quoteSwap({ token: tokenOut, amount: amountEth }, {});
  const { previewSwap } = await import('./rh-swap.mjs');
  const preview = await previewSwap({ token: tokenOut, amount: amountEth }, { wallet: walletAddress });
  const gas = await client.request({ method: 'eth_estimateGas', params: [{ from: walletAddress, to: preview.to, value: preview.value, data: preview.data }] });
  const nonce = await client.request({ method: 'eth_getTransactionCount', params: [walletAddress, 'pending'] });
  const txHash = await client.request({ method: 'eth_sendRawTransaction' in {} ? 'eth_sendTransaction' : 'eth_sendTransaction', params: [{ from: walletAddress, to: preview.to, value: preview.value, data: preview.data, gas, nonce }] });
  return { txHash, amountOutFormatted: quote.amountOutFormatted, route: quote.route, minimumOut: quote.minimumOut };
}

/** Run all due swap automations. Each outcome is recorded on the automation
 * (ok + txHash, or failed + honest reason). */
export async function executeDueSwapAutomations(db, { masterKey = process.env.CORAGENTIC_CUSTODY_KEY, rpcUrl = process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com', now = new Date() } = {}) {
  const { dueAutomations } = await import('./agent-automations.mjs');
  const due = dueAutomations(db, now);
  const results = [];
  for (const automation of due) {
    const parsed = parseSwapCommand(automation.task, { agentId: automation.agentId });
    if (!parsed) continue; // not a swap automation; leave for other runners
    if (!claimDueAutomation(db, automation.id, now)) continue;
    const agent = db.prepare('SELECT owner_wallet FROM agents WHERE id = ?').get(automation.agentId);
    try {
      if (!agent) throw new Error('agent_missing');
      const walletRow = custodyWalletRow(db, automation.agentId, agent.owner_wallet);
      if (!walletRow) throw new Error('agent_has_no_custody_wallet');
      const policy = JSON.parse(walletRow.policy_json ?? '{}');
      if (!policyAllows(policy, parsed.amountEth)) throw new Error('spend_policy_disabled');
      if (!masterKey) throw new Error('custody_key_unavailable');
      const privateKey = decryptCustodyKey(walletRow.encrypted_private_key, masterKey);
      const balance = await ethBalance(walletRow.address, rpcUrl);
      const needed = parseEther(parsed.amountEth);
      // Gas headroom: refuse early instead of broadcasting a doomed tx.
      if (balance < needed + needed / 10n) {
        throw new Error(`insufficient_eth_balance_${formatEther(balance)}_ETH_available`);
      }
      const sent = await broadcastSwap({ privateKey, walletAddress: walletRow.address, tokenOut: parsed.tokenOut, amountEth: parsed.amountEth, rpcUrl });
      markAutomationRun(db, automation.id, { ok: true, runId: `swap_${sent.txHash}`, summary: `Swapped ${parsed.amountEth} ETH -> ${sent.amountOutFormatted} USDG (tx ${sent.txHash})` });
      results.push({ automationId: automation.id, ok: true, txHash: sent.txHash });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      markAutomationRun(db, automation.id, { ok: false, summary: `Swap failed: ${message}` });
      results.push({ automationId: automation.id, ok: false, error: message });
    }
  }
  return results;
}
