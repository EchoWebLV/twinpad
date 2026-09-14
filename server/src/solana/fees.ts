import {
  PublicKey,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import {
  ATA_PROGRAM,
  PUMP_AMM_PROGRAM,
  PUMP_FEES_PROGRAM,
  PUMP_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  WSOL,
  pda,
} from "./pump.js";

/**
 * Pump Fees program instruction builders. Account lists copy TWINE's own
 * transactions on-chain byte for byte (spec §3.5):
 *   create: s5pQUhFSPfd7Mx5D7e7H5o6L8wFsgV4wQ7zPifuxzRRztAuacNm7o89i3V5t4dyppW8283a4WPnwVjvKmShkY8w
 *   update: 3jE127wcGUurF81L21wakhykKDpEWs5c4UrBofheZomUB6sGEXveamVpAMuzizoQYtVXkMwRA2JAVfNRCB6yU6Lp
 */
const DISC_CREATE = Buffer.from("c34e564c6f34fbd5", "hex");
const DISC_UPDATE = Buffer.from("bd0d8863bba4ed23", "hex");

const meta = (pubkey: PublicKey, isWritable = false, isSigner = false): AccountMeta => ({
  pubkey,
  isWritable,
  isSigner,
});

export interface Shareholder {
  address: PublicKey;
  shareBps: number;
}

/** `create_fee_sharing_config` — no args. Payer funds 1024 bytes of rent. Pre-graduation the `pool` slot is the fee program itself (as TWINE did). */
export function createFeeSharingConfigIx(payer: PublicKey, mint: PublicKey, pumpSwapPool?: PublicKey) {
  const sharingConfig = pda.sharingConfig(mint);
  const keys: AccountMeta[] = [
    meta(pda.feesEventAuthority()),
    meta(PUMP_FEES_PROGRAM),
    meta(payer, true, true),
    meta(pda.global()),
    meta(mint),
    meta(sharingConfig, true),
    meta(SYSTEM_PROGRAM),
    meta(pda.bondingCurve(mint), true),
    meta(PUMP_PROGRAM),
    meta(pda.pumpEventAuthority()),
    meta(pumpSwapPool ?? PUMP_FEES_PROGRAM, true),
    meta(PUMP_AMM_PROGRAM),
    meta(pda.ammEventAuthority()),
  ];
  return new TransactionInstruction({ programId: PUMP_FEES_PROGRAM, keys, data: DISC_CREATE });
}

/**
 * `update_fee_shares` — one-shot (sets admin_revoked). Sweeps pending fees to the
 * *current* shareholders first, which is why they are appended as remaining accounts.
 */
export function updateFeeSharesIx(
  authority: PublicKey,
  mint: PublicKey,
  shareholders: Shareholder[],
  currentShareholders: PublicKey[],
) {
  const total = shareholders.reduce((a, s) => a + s.shareBps, 0);
  if (shareholders.length < 1 || shareholders.length > 10) throw new Error("1..10 shareholders");
  if (total !== 10_000) throw new Error(`share_bps must sum to 10000, got ${total}`);
  const seen = new Set<string>();
  for (const s of shareholders) {
    if (s.shareBps <= 0) throw new Error("share_bps must be > 0");
    const k = s.address.toBase58();
    if (seen.has(k)) throw new Error(`duplicate shareholder ${k}`);
    seen.add(k);
  }
  const sharingConfig = pda.sharingConfig(mint);
  const ammVaultAuthority = pda.ammCreatorVaultAuthority(sharingConfig);
  const keys: AccountMeta[] = [
    meta(pda.feesEventAuthority()),
    meta(PUMP_FEES_PROGRAM),
    meta(authority, false, true),
    meta(pda.global()),
    meta(mint),
    meta(sharingConfig, true),
    meta(pda.bondingCurve(mint)),
    meta(pda.pumpCreatorVault(sharingConfig), true),
    meta(SYSTEM_PROGRAM),
    meta(PUMP_PROGRAM),
    meta(pda.pumpEventAuthority()),
    meta(PUMP_AMM_PROGRAM),
    meta(pda.ammEventAuthority()),
    meta(WSOL),
    meta(TOKEN_PROGRAM),
    meta(ATA_PROGRAM),
    meta(ammVaultAuthority, true),
    meta(pda.ata(ammVaultAuthority, WSOL, TOKEN_PROGRAM), true),
    ...currentShareholders.map((k) => meta(k, true)),
  ];
  // Borsh: u32 len + (pubkey 32, u16 share_bps) per entry
  const body = Buffer.alloc(4 + shareholders.length * 34);
  body.writeUInt32LE(shareholders.length, 0);
  shareholders.forEach((s, i) => {
    s.address.toBuffer().copy(body, 4 + i * 34);
    body.writeUInt16LE(s.shareBps, 4 + i * 34 + 32);
  });
  return new TransactionInstruction({
    programId: PUMP_FEES_PROGRAM,
    keys,
    data: Buffer.concat([DISC_UPDATE, body]),
  });
}
