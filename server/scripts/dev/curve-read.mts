import { publicClient, readCurve, quoteBuy, quoteSell } from "../../src/evm/pons.ts";
const c = publicClient("https://rpc.ordofi.network");
const s = await readCurve(c, process.argv[2] as `0x${string}` ?? "0xe27501d787d647CC82a5B4a7Eafd5750386F1B77");
console.log({ phase: s.phase, graduated: s.graduated, ready: s.readyToGraduate, price: s.price, fdvEth: s.fdvEth, progress: s.progress, depthEth: s.quoteDepthEth, sellable: s.sellableTokens.toString(), feeBps: s.feeBps.toString(), taxBps: s.creatorTaxBps });
console.log("quoteBuy 0.1 ETH:", await quoteBuy(c, s.curve, 10n ** 17n, "0x0cA689eC5898b1BCBD0aeC0D28490732f0cf7528"));
console.log("quoteSell 1M:", await quoteSell(c, s.curve, 10n ** 24n));
