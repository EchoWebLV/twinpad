import { Connection, Keypair } from "@solana/web3.js";
import type { PublicClient } from "viem";
import type { Config } from "./config.js";
import type { Registry } from "./registry.js";
import type { CoinState } from "./coin.js";
import { Maker } from "./maker.js";
import { walletClient } from "./evm/pons.js";
import type { Recovery } from "./recover.js";

/** One Maker per live coin, armed when the coin appears (`engine_armed`). */
export class Makers {
  private makers = new Map<string, Maker>();
  private coins = new Map<string, CoinState>();
  constructor(private cfg: Config, private registry: Registry, private conn: Connection, private pub: PublicClient, private recovery?: Recovery) {}

  register(coin: CoinState) {
    this.coins.set(coin.id, coin);
  }

  arm(coin: CoinState) {
    this.register(coin);
    if (this.makers.has(coin.id) || !this.cfg.maker.enabled) return;
    const keys = this.registry.keys(coin.id);
    const m = new Maker(this.cfg, coin, this.conn, Keypair.fromSecretKey(Uint8Array.from(keys.solMaker ?? keys.solCreator)), this.pub, walletClient(this.cfg.evm.rpcUrl, keys.evmMaker), this.recovery, Keypair.fromSecretKey(Uint8Array.from(keys.solCreator)));
    this.makers.set(coin.id, m);
    m.start();
    console.log(`[maker ${coin.id}] armed`);
  }

  halt(id: string, reason = "admin") {
    const m = this.makers.get(id);
    if (!m) return false;
    m.stop();
    const c = this.coins.get(id);
    if (c) { c.maker.halted = true; c.maker.haltReason = reason; }
    return true;
  }

  resume(id: string) {
    const m = this.makers.get(id);
    if (!m) return false;
    m.resume();
    return true;
  }

  setMode(id: string, mode: "peg" | "selldown") {
    const m = this.makers.get(id);
    if (!m) return false;
    m.setMode(mode);
    return true;
  }

  /** Halt, wait for the in-flight tick, and forget the maker; the coin stays registered so arm() brings it back. */
  async park(id: string, reason: string) {
    const m = this.makers.get(id);
    if (!m) return;
    this.halt(id, reason);
    await m.settle();
    this.makers.delete(id);
  }

  /** Stop and forget a maker (the coin is closing). */
  disarm(id: string) {
    this.halt(id, "closing");
    this.makers.delete(id);
    this.coins.delete(id);
  }

  haltAll(reason: string) {
    for (const id of this.makers.keys()) this.halt(id, reason);
  }
}
