import { readFileSync } from 'node:fs';
import { createPublicClient, http } from 'viem';

// Standard ERC20 Transfer(address indexed from, address indexed to, uint256 value)
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const USDG_ABI = JSON.parse(readFileSync(new URL('./abi/usdg-eip3009.json', import.meta.url), 'utf8'));

export const CHAIN_ID = 4663;
export const USDG_ADDRESS = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
export { USDG_ABI };

function isTxHash(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

/**
 * Non-custodial x402 settlement verifier: the PAYER submits their own plain
 * ERC20 transfer (paying their own gas, no relayer, no gasless authorization,
 * no server-held funds or keys anywhere). This module only reads a public
 * transaction receipt and checks that a matching Transfer log paid the
 * required amount to the required recipient. It never signs, holds, or
 * submits anything. This mirrors the same non-custodial verify-by-tx-hash
 * pattern used by the Verge x402 facilitator (sdk/core verifyStablecoinTransferDetailed).
 */
export function createDirectTransferFacilitator({
  publicClient = createPublicClient({
    chain: { id: CHAIN_ID },
    transport: http(process.env.ROBINHOOD_RPC_URL || 'https://robinhood-rpc.publicnode.com', {
      fetchOptions: { headers: { 'user-agent': 'coragentic-x402-facilitator/1.0' } },
    }),
  }),
  // Minimum block confirmations before a settlement is accepted as final. A
  // freshly-mined block can still be reorged out; requiring a small depth of
  // confirmation before recording an irrevocable settlement bounds that risk.
  // Robinhood Chain block time and finality characteristics haven't published
  // a formal finality guarantee, so this defaults conservatively; callers can
  // override it explicitly if a different policy is chosen.
  confirmations = 3,
} = {}) {
  return {
    /**
     * Verify that `txHash` is a successful on-chain transaction containing an
     * ERC20 Transfer log on `requirement.accepts[0].asset` paying at least
     * `requirement.accepts[0].amount` to `requirement.accepts[0].payTo`, that
     * the receipt is buried under at least `confirmations` blocks, and that
     * the RPC being queried actually reports the expected chain id.
     * Returns { status: 'verified', payer, txHash, amount, confirmations } |
     * { status: 'invalid', reason } | { status: 'unavailable', reason }.
     */
    async verifyTransaction(txHash, requirement) {
      if (!isTxHash(txHash)) return { status: 'invalid', reason: 'malformed_tx_hash' };

      const accept = Array.isArray(requirement?.accepts)
        ? requirement.accepts.find((entry) => entry?.network === 'eip155:4663' && entry?.scheme === 'exact')
        : null;
      if (!accept) return { status: 'invalid', reason: 'no_matching_requirement' };

      // Refuse to trust an RPC that doesn't actually report the chain we think
      // we're settling on -- a misconfigured or malicious RPC endpoint could
      // otherwise return a receipt for the same tx hash on a different chain.
      let reportedChainId;
      try {
        reportedChainId = await publicClient.getChainId();
      } catch {
        return { status: 'unavailable', reason: 'rpc_unavailable' };
      }
      if (Number(reportedChainId) !== CHAIN_ID) return { status: 'unavailable', reason: 'rpc_chain_id_mismatch' };

      let receipt;
      try {
        receipt = await publicClient.getTransactionReceipt({ hash: txHash });
      } catch {
        return { status: 'invalid', reason: 'transaction_not_found' };
      }
      if (!receipt) return { status: 'invalid', reason: 'transaction_not_found' };
      if (receipt.status !== 'success') return { status: 'invalid', reason: 'transaction_failed' };

      // Confirmation-depth check: a receipt that exists but is still within the
      // reorg-risk window must not be treated as final. This is deliberately
      // 'unavailable' rather than 'invalid' -- the payment may well be genuine
      // and simply needs more time, so the caller should retry rather than
      // treat it as a rejected/failed payment.
      let currentBlock;
      try {
        currentBlock = await publicClient.getBlockNumber();
      } catch {
        return { status: 'unavailable', reason: 'rpc_unavailable' };
      }
      const receiptBlock = BigInt(receipt.blockNumber);
      const actualConfirmations = Number(BigInt(currentBlock) - receiptBlock) + 1;
      if (actualConfirmations < confirmations) {
        return { status: 'unavailable', reason: 'insufficient_confirmations' };
      }

      const assetLower = accept.asset.toLowerCase();
      const payToLower = accept.payTo.toLowerCase();
      const requiredAmount = BigInt(accept.amount);

      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== assetLower) continue;
        if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length < 3) continue;
        const toTopic = log.topics[2];
        const toAddr = `0x${toTopic.slice(26)}`.toLowerCase();
        if (toAddr !== payToLower) continue;
        const value = BigInt(log.data);
        if (value >= requiredAmount) {
          const fromTopic = log.topics[1];
          const payer = fromTopic ? `0x${fromTopic.slice(26)}` : null;
          return { status: 'verified', payer, txHash, amount: value.toString(), confirmations: actualConfirmations };
        }
      }
      return { status: 'invalid', reason: 'no_matching_transfer_log' };
    },
  };
}
