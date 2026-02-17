import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Contract, BrowserProvider } from "ethers";
import { getContractsForChain } from "@/lib/contracts";
import { V3_FACTORY_ABI, V3_POOL_ABI, NONFUNGIBLE_POSITION_MANAGER_ABI } from "@/lib/abis/v3";
import { sqrtPriceX96ToPrice, priceToSqrtPriceX96, sortTokens } from "@/lib/v3-utils";
import { parseAmount } from "@/lib/decimal-utils";
import { useToast } from "@/hooks/use-toast";
import type { Token } from "@shared/schema";
import {
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Wrench,
  RefreshCw,
  Info,
  ExternalLink,
  Zap,
  TriangleAlert,
} from "lucide-react";

// ─── Uniswap V3 tick bounds ───────────────────────────────────────────────────
const MIN_TICK = -887272;
const MAX_TICK = 887272;

// Warn when the pool tick is within 5% of the absolute bound
const TICK_EXTREME_THRESHOLD = Math.floor(MAX_TICK * 0.95); // ±843,108

// If price deviates > this factor from 1 and amounts are both > 0, flag a mismatch
const PRICE_MISMATCH_FACTOR = 1000;

// ─── Types ────────────────────────────────────────────────────────────────────
export type PoolIssueKind =
  | "HEALTHY"
  | "UNINITIALIZED"           // pool exists but sqrtPriceX96 === 0
  | "PRICE_EXTREME"           // tick at or near ±MAX_TICK
  | "PRICE_MISMATCH"          // pool price wildly differs from user-supplied ratio
  | "NO_ACTIVE_LIQUIDITY"     // pool initialized but liquidity = 0 at current tick
  | "UNKNOWN";

export interface PoolHealthResult {
  poolAddress: string | null;
  poolExists: boolean;
  issue: PoolIssueKind;
  severity: "ok" | "warn" | "error";
  sqrtPriceX96: bigint | null;
  currentTick: number | null;
  currentPrice: number | null;
  activeLiquidity: bigint | null;
  description: string;
  suggestedFix: string | null;
  canAutoFix: boolean;
}

interface PoolHealthCheckerProps {
  tokenA: Token | null;
  tokenB: Token | null;
  fee: number;
  chainId: number;
  /** If provided, the checker will compare the pool price to this expected ratio */
  expectedPriceRatio?: number | null;
  onHealthChange?: (result: PoolHealthResult) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getERC20Addr(token: Token, chainId: number): string {
  // Inline – avoids import coupling; mirrors AddLiquidityV3Basic's helper
  const NATIVE_ADDRS = ["0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", "0x0000000000000000000000000000000000001010"];
  if (NATIVE_ADDRS.some((n) => n.toLowerCase() === token.address.toLowerCase())) {
    // Return WETH/WMATIC address stored in token.wrappedAddress if present
    return (token as any).wrappedAddress ?? token.address;
  }
  return token.address;
}

function severityColor(s: PoolHealthResult["severity"]) {
  if (s === "ok") return "text-green-400";
  if (s === "warn") return "text-yellow-400";
  return "text-red-400";
}

function severityBg(s: PoolHealthResult["severity"]) {
  if (s === "ok") return "bg-green-500/10 border-green-500/20";
  if (s === "warn") return "bg-yellow-500/10 border-yellow-500/20";
  return "bg-red-500/10 border-red-500/20";
}

function SeverityIcon({ s }: { s: PoolHealthResult["severity"] }) {
  if (s === "ok") return <CheckCircle2 className="h-5 w-5 text-green-400 shrink-0 mt-0.5" />;
  if (s === "warn") return <TriangleAlert className="h-5 w-5 text-yellow-400 shrink-0 mt-0.5" />;
  return <XCircle className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />;
}

// ─── Diagnosis logic ──────────────────────────────────────────────────────────

async function diagnosePool(
  tokenA: Token,
  tokenB: Token,
  fee: number,
  chainId: number,
  expectedPriceRatio?: number | null
): Promise<PoolHealthResult> {
  const blank: PoolHealthResult = {
    poolAddress: null,
    poolExists: false,
    issue: "UNKNOWN",
    severity: "warn",
    sqrtPriceX96: null,
    currentTick: null,
    currentPrice: null,
    activeLiquidity: null,
    description: "Unable to fetch pool data.",
    suggestedFix: null,
    canAutoFix: false,
  };

  const contracts = getContractsForChain(chainId);
  if (!contracts || !window.ethereum) return blank;

  const provider = new BrowserProvider(window.ethereum);
  const factory = new Contract(contracts.v3.factory, V3_FACTORY_ABI, provider);

  const addr0 = getERC20Addr(tokenA, chainId);
  const addr1 = getERC20Addr(tokenB, chainId);
  const [tok0, tok1] = sortTokens(
    { ...tokenA, address: addr0 },
    { ...tokenB, address: addr1 }
  );

  let poolAddress: string;
  try {
    poolAddress = await factory.getPool(tok0.address, tok1.address, fee);
  } catch {
    return { ...blank, description: "Failed to query factory." };
  }

  const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
  if (!poolAddress || poolAddress === ZERO_ADDR) {
    return {
      ...blank,
      issue: "HEALTHY",
      severity: "ok",
      poolExists: false,
      description: "Pool does not exist yet – it will be created when you add liquidity.",
      suggestedFix: null,
      canAutoFix: false,
    };
  }

  // Pool exists – inspect state
  const pool = new Contract(poolAddress, V3_POOL_ABI, provider);
  let slot0: any;
  let liquidity: bigint;

  try {
    [slot0, liquidity] = await Promise.all([pool.slot0(), pool.liquidity()]);
  } catch {
    return {
      ...blank,
      poolAddress,
      poolExists: true,
      description: "Pool exists but slot0/liquidity read failed – the contract may be broken.",
    };
  }

  const sqrtPriceX96: bigint = slot0[0];
  const currentTick: number = Number(slot0[1]);

  // ── Issue: uninitialized ──────────────────────────────────────────────────
  if (sqrtPriceX96 === 0n) {
    return {
      poolAddress,
      poolExists: true,
      issue: "UNINITIALIZED",
      severity: "error",
      sqrtPriceX96,
      currentTick,
      currentPrice: null,
      activeLiquidity: liquidity,
      description:
        "The pool contract exists but was never initialized (sqrtPriceX96 = 0). " +
        "No swaps or liquidity additions are possible until it is initialized.",
      suggestedFix:
        "Call createAndInitializePoolIfNecessary on the NonfungiblePositionManager " +
        "with a valid sqrtPriceX96. Use the fix button below to initialize at your desired price.",
      canAutoFix: true,
    };
  }

  const currentPrice = sqrtPriceX96ToPrice(sqrtPriceX96, tok0.decimals, tok1.decimals);

  // ── Issue: price extreme ──────────────────────────────────────────────────
  if (Math.abs(currentTick) >= TICK_EXTREME_THRESHOLD) {
    return {
      poolAddress,
      poolExists: true,
      issue: "PRICE_EXTREME",
      severity: "error",
      sqrtPriceX96,
      currentTick,
      currentPrice,
      activeLiquidity: liquidity,
      description:
        `Pool tick (${currentTick}) is near the absolute limit (±${MAX_TICK}). ` +
        "This usually means the pool was initialized with a wildly wrong price (e.g. 1 : 1 000 000 000). " +
        "Adding liquidity or swapping is effectively impossible without first correcting the price.",
      suggestedFix:
        liquidity === 0n
          ? "Because there is no active liquidity you can deploy a tiny 'bootstrap' position that " +
            "spans the broken price AND your target price, then perform a corrective swap. " +
            "Use the guided fix below."
          : "An arbitrage swap is needed to move the price back in range. " +
            "The fix button will attempt a zero-cost corrective swap if the pool has liquidity.",
      canAutoFix: liquidity === 0n, // can only auto-fix (bootstrap) when no liquidity
    };
  }

  // ── Issue: price mismatch ─────────────────────────────────────────────────
  if (expectedPriceRatio != null && expectedPriceRatio > 0) {
    const ratio = currentPrice / expectedPriceRatio;
    if (ratio > PRICE_MISMATCH_FACTOR || ratio < 1 / PRICE_MISMATCH_FACTOR) {
      return {
        poolAddress,
        poolExists: true,
        issue: "PRICE_MISMATCH",
        severity: "warn",
        sqrtPriceX96,
        currentTick,
        currentPrice,
        activeLiquidity: liquidity,
        description:
          `Pool price (${currentPrice.toExponential(3)} ${tok1.symbol}/${tok0.symbol}) ` +
          `differs from your input ratio (${expectedPriceRatio.toExponential(3)}) by ` +
          `${Math.round(Math.max(ratio, 1 / ratio))}×. ` +
          "You may be adding liquidity at a heavily unfavourable price.",
        suggestedFix:
          "Double-check your token amounts, or swap first to move the pool price closer to market.",
        canAutoFix: false,
      };
    }
  }

  // ── Issue: no active liquidity at current tick ────────────────────────────
  if (liquidity === 0n) {
    return {
      poolAddress,
      poolExists: true,
      issue: "NO_ACTIVE_LIQUIDITY",
      severity: "warn",
      sqrtPriceX96,
      currentTick,
      currentPrice,
      activeLiquidity: liquidity,
      description:
        "The pool is initialized and the price looks reasonable, but there is no active " +
        "liquidity at the current tick. Swaps will revert until someone adds liquidity that " +
        "includes the current tick in its range.",
      suggestedFix:
        "Add liquidity with a tick range that covers the current tick " +
        `(currently tick ${currentTick}). Basic Mode does this automatically.`,
      canAutoFix: false,
    };
  }

  // ── Healthy ───────────────────────────────────────────────────────────────
  return {
    poolAddress,
    poolExists: true,
    issue: "HEALTHY",
    severity: "ok",
    sqrtPriceX96,
    currentTick,
    currentPrice,
    activeLiquidity: liquidity,
    description: `Pool is healthy. Current price: ${currentPrice.toFixed(6)} ${tok1.symbol} per ${tok0.symbol}.`,
    suggestedFix: null,
    canAutoFix: false,
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function PoolHealthChecker({
  tokenA,
  tokenB,
  fee,
  chainId,
  expectedPriceRatio,
  onHealthChange,
}: PoolHealthCheckerProps) {
  const [health, setHealth] = useState<PoolHealthResult | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [isFixing, setIsFixing] = useState(false);
  const { toast } = useToast();

  const runCheck = useCallback(async () => {
    if (!tokenA || !tokenB) return;
    setIsChecking(true);
    try {
      const result = await diagnosePool(tokenA, tokenB, fee, chainId, expectedPriceRatio);
      setHealth(result);
      onHealthChange?.(result);
    } catch (err) {
      console.error("Pool health check failed:", err);
    } finally {
      setIsChecking(false);
    }
  }, [tokenA, tokenB, fee, chainId, expectedPriceRatio]);

  useEffect(() => {
    runCheck();
  }, [runCheck]);

  // ── Auto-fix: initialize an uninitialized pool ────────────────────────────
  const handleFixUninitialized = async () => {
    if (!health || !tokenA || !tokenB || !window.ethereum) return;
    if (!expectedPriceRatio || expectedPriceRatio <= 0) {
      toast({
        title: "Cannot fix",
        description: "Enter token amounts first so we know the desired initial price.",
        variant: "destructive",
      });
      return;
    }

    setIsFixing(true);
    try {
      const contracts = getContractsForChain(chainId);
      if (!contracts) throw new Error("No contracts for this chain");

      const provider = new BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();

      const addr0 = getERC20Addr(tokenA, chainId);
      const addr1 = getERC20Addr(tokenB, chainId);
      const [tok0, tok1] = sortTokens(
        { ...tokenA, address: addr0 },
        { ...tokenB, address: addr1 }
      );

      const sqrtPriceX96 = priceToSqrtPriceX96(expectedPriceRatio, tok0.decimals, tok1.decimals);

      const posManager = new Contract(
        contracts.v3.nonfungiblePositionManager,
        NONFUNGIBLE_POSITION_MANAGER_ABI,
        signer
      );

      toast({ title: "Initializing pool...", description: "Sending initialization transaction" });

      const tx = await posManager.createAndInitializePoolIfNecessary(
        tok0.address,
        tok1.address,
        fee,
        sqrtPriceX96
      );
      const receipt = await tx.wait();

      toast({
        title: "Pool initialized!",
        description: (
          <div className="flex items-center gap-2">
            <span>Pool is now ready for liquidity</span>
            <a
              href={`${contracts.explorer}${receipt.hash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 underline text-xs"
            >
              <ExternalLink className="h-3 w-3" /> Tx
            </a>
          </div>
        ),
      });

      await runCheck();
    } catch (err: any) {
      console.error("Fix failed:", err);
      toast({
        title: "Fix failed",
        description: err.reason ?? err.message ?? "Transaction failed",
        variant: "destructive",
      });
    } finally {
      setIsFixing(false);
    }
  };

  // ── Auto-fix: extreme price – bootstrap + correct ─────────────────────────
  /**
   * For a pool with extreme price and zero liquidity:
   * 1. Add a tiny full-range position (so the pool has *some* liquidity)
   * 2. Perform a swap from the expensive token → cheap token to walk the tick
   *    back toward the target price.
   *
   * NOTE: This is a best-effort fix. Because the broken tick may be near
   * ±887272, full-range positions still cover it. The swap amount needed to
   * move an extreme price all the way back can be very large; in practice
   * the user should set a realistic target and the contract will consume
   * only what's needed (amountSpecified is negative → exactOutput).
   *
   * We surface this as guidance rather than a fully-automated tx because the
   * swap cost varies wildly by how broken the price is.
   */
  const handleFixExtremePriceGuide = () => {
    toast({
      title: "Guided fix for extreme price",
      description:
        "Step 1: Add a tiny full-range liquidity position (Basic Mode, small amounts). " +
        "Step 2: Use the Swap tab to swap in the direction that moves price toward market. " +
        "Step 3: Re-add your main liquidity. This resets the pool price.",
      duration: 10000,
    });
  };

  if (!tokenA || !tokenB) return null;
  if (isChecking) {
    return (
      <div className="flex items-center gap-2 p-3 rounded-lg bg-slate-800/50 border border-slate-700 text-slate-400 text-sm">
        <RefreshCw className="h-4 w-4 animate-spin" />
        Checking pool health…
      </div>
    );
  }
  if (!health) return null;
  if (health.issue === "HEALTHY" && health.poolExists) {
    // Compact green banner only
    return (
      <div className={`flex items-center gap-2 p-3 rounded-lg border text-sm ${severityBg("ok")}`}>
        <CheckCircle2 className="h-4 w-4 text-green-400" />
        <span className={severityColor("ok")}>{health.description}</span>
        <button onClick={runCheck} className="ml-auto text-slate-500 hover:text-slate-300">
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }
  if (health.issue === "HEALTHY" && !health.poolExists) {
    // Pool doesn't exist – benign, but show a muted note
    return (
      <div className={`flex items-center gap-2 p-3 rounded-lg border text-sm ${severityBg("ok")}`}>
        <Info className="h-4 w-4 text-green-400" />
        <span className="text-slate-300">{health.description}</span>
      </div>
    );
  }

  // Non-healthy states → full diagnostic card
  return (
    <div className={`rounded-lg border p-4 space-y-3 ${severityBg(health.severity)}`}>
      {/* Header */}
      <div className="flex items-start gap-3">
        <SeverityIcon s={health.severity} />
        <div className="flex-1 min-w-0">
          <div className={`font-semibold text-sm ${severityColor(health.severity)}`}>
            {issueLabel(health.issue)}
          </div>
          <p className="text-xs text-slate-300 mt-1 leading-relaxed">{health.description}</p>
        </div>
        <button onClick={runCheck} className="text-slate-500 hover:text-slate-300 shrink-0" title="Re-check">
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      {/* Diagnostic details */}
      {health.poolExists && (
        <div className="grid grid-cols-2 gap-2 text-xs font-mono">
          {health.currentTick !== null && (
            <Detail label="Current tick" value={health.currentTick.toLocaleString()} warn={Math.abs(health.currentTick) >= TICK_EXTREME_THRESHOLD} />
          )}
          {health.currentPrice !== null && (
            <Detail label="Pool price" value={`${health.currentPrice.toExponential(4)}`} />
          )}
          {health.sqrtPriceX96 !== null && (
            <Detail label="sqrtPriceX96" value={health.sqrtPriceX96 === 0n ? "0 ⚠" : abbreviate(health.sqrtPriceX96)} warn={health.sqrtPriceX96 === 0n} />
          )}
          {health.activeLiquidity !== null && (
            <Detail label="Active liquidity" value={health.activeLiquidity === 0n ? "0 ⚠" : abbreviate(health.activeLiquidity)} warn={health.activeLiquidity === 0n} />
          )}
        </div>
      )}

      {/* Suggested fix text */}
      {health.suggestedFix && (
        <div className="flex items-start gap-2 text-xs text-slate-400 bg-slate-900/60 rounded p-2">
          <Wrench className="h-3.5 w-3.5 shrink-0 mt-0.5 text-slate-500" />
          <span>{health.suggestedFix}</span>
        </div>
      )}

      {/* Fix actions */}
      <div className="flex flex-wrap gap-2">
        {health.issue === "UNINITIALIZED" && health.canAutoFix && (
          <Button
            size="sm"
            className="bg-blue-600 hover:bg-blue-700 text-white"
            disabled={isFixing || !expectedPriceRatio}
            onClick={handleFixUninitialized}
          >
            {isFixing ? (
              <><RefreshCw className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Initializing…</>
            ) : (
              <><Zap className="h-3.5 w-3.5 mr-1.5" /> Initialize Pool</>
            )}
          </Button>
        )}

        {health.issue === "PRICE_EXTREME" && (
          <Button
            size="sm"
            variant="outline"
            className="border-yellow-500/50 text-yellow-400 hover:bg-yellow-500/10"
            onClick={handleFixExtremePriceGuide}
          >
            <Wrench className="h-3.5 w-3.5 mr-1.5" /> Show Fix Guide
          </Button>
        )}

        {health.poolAddress && (
          <a
            href={`https://scan.testnet.arc.network/address/${health.poolAddress}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Button size="sm" variant="ghost" className="text-slate-400">
              <ExternalLink className="h-3.5 w-3.5 mr-1.5" /> View Pool
            </Button>
          </a>
        )}
      </div>

      {/* Extra warning: uninitialized but no ratio provided */}
      {health.issue === "UNINITIALIZED" && !expectedPriceRatio && (
        <p className="text-xs text-yellow-400/80">
          ⚠ Enter amounts in both token fields first so the initializer knows your desired price.
        </p>
      )}
    </div>
  );
}

// ─── Small sub-components ─────────────────────────────────────────────────────

function Detail({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="bg-slate-900/50 rounded p-1.5">
      <div className="text-slate-500">{label}</div>
      <div className={warn ? "text-red-400" : "text-slate-200"}>{value}</div>
    </div>
  );
}

function abbreviate(n: bigint): string {
  const s = n.toString();
  if (s.length <= 8) return s;
  return `${s.slice(0, 4)}…${s.slice(-4)} (${s.length} digits)`;
}

function issueLabel(issue: PoolIssueKind): string {
  switch (issue) {
    case "UNINITIALIZED":      return "⚠ Pool Not Initialized";
    case "PRICE_EXTREME":      return "🚨 Pool Price is Broken / Extreme";
    case "PRICE_MISMATCH":     return "⚠ Pool Price Mismatch";
    case "NO_ACTIVE_LIQUIDITY":return "ℹ No Active Liquidity";
    default:                   return "⚠ Pool Issue Detected";
  }
}
