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
} = {}) {
  return {
    /**
     * Verify that `txHash` is a successful on-chain transaction containing an
     * ERC20 Transfer log on `requirement.accepts[0].asset` paying at least
     * `requirement.accepts[0].amount` to `requirement.accepts[0].payTo`.
     * Returns { status: 'verified', payer, txHash } | { status: 'invalid', reason } |
     * { status: 'unavailable', reason }.
     */
    async verifyTransaction(txHash, requirement) {
      if (!isTxHash(txHash)) return { status: 'invalid', reason: 'malformed_tx_hash' };

      const accept = Array.isArray(requirement?.accepts)
        ? requirement.accepts.find((entry) => entry?.network === 'eip155:4663' && entry?.scheme === 'exact')
        : null;
      if (!accept) return { status: 'invalid', reason: 'no_matching_requirement' };

      let receipt;
      try {
        receipt = await publicClient.getTransactionReceipt({ hash: txHash });
      } catch {
        return { status: 'invalid', reason: 'transaction_not_found' };
      }
      if (!receipt) return { status: 'invalid', reason: 'transaction_not_found' };
      if (receipt.status !== 'success') return { status: 'invalid', reason: 'transaction_failed' };

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
          return { status: 'verified', payer, txHash, amount: value.toString() };
        }
      }
      return { status: 'invalid', reason: 'no_matching_transfer_log' };
    },
  };
}
