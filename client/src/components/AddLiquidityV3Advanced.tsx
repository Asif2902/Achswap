import { useState, useEffect, useCallback, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TokenSelector } from "@/components/TokenSelector";
import { useAccount, useChainId } from "wagmi";
import { useToast } from "@/hooks/use-toast";
import type { Token } from "@shared/schema";
import { Contract, BrowserProvider, formatUnits } from "ethers";
import { getTokensByChainId, isNativeToken, getWrappedAddress } from "@/data/tokens";
import { formatAmount, parseAmount } from "@/lib/decimal-utils";
import { getContractsForChain } from "@/lib/contracts";
import {
  NONFUNGIBLE_POSITION_MANAGER_ABI,
  V3_FACTORY_ABI,
  V3_POOL_ABI,
  V3_FEE_TIERS,
  FEE_TIER_LABELS,
} from "@/lib/abis/v3";
import {
  priceToSqrtPriceX96,
  sqrtPriceX96ToPrice,
  priceToTick,
  tickToPrice,
  getNearestUsableTick,
  getTickSpacing,
  sortTokens,
  isPositionInRange,
  getFullRangeTicks,
} from "@/lib/v3-utils";
import { calculateAmountsForLiquidity } from "@/lib/v3-liquidity-math";
import {
  AlertTriangle,
  Zap,
  ExternalLink,
  TrendingUp,
  TrendingDown,
  Info,
  Settings,
  BarChart3,
  Shield,
  ArrowUpDown,
  Layers,
  Target,
  Activity,
} from "lucide-react";
import { PriceRangeChart } from "./PriceRangeChart";

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
];

function getERC20Address(token: Token, chainId: number): string {
  if (isNativeToken(token.address)) {
    const wrapped = getWrappedAddress(chainId, token.address);
    return wrapped || token.address;
  }
  return token.address;
}

// Position deposit type derived from current price vs range
type DepositMode = "dual" | "token0-only" | "token1-only" | "unknown";

export function AddLiquidityV3Advanced() {
  // ── Token state ────────────────────────────────────────────────────────────
  const [tokenA, setTokenA] = useState<Token | null>(null);
  const [tokenB, setTokenB] = useState<Token | null>(null);
  const [amountA, setAmountA] = useState("");
  const [amountB, setAmountB] = useState("");
  const [showTokenASelector, setShowTokenASelector] = useState(false);
  const [showTokenBSelector, setShowTokenBSelector] = useState(false);
  const [tokens, setTokens] = useState<Token[]>([]);

  // ── Fee / range state ──────────────────────────────────────────────────────
  const [selectedFee, setSelectedFee] = useState<number>(V3_FEE_TIERS.MEDIUM);
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [minTick, setMinTick] = useState("");
  const [maxTick, setMaxTick] = useState("");
  const [useTickMode, setUseTickMode] = useState(false);
  const [slippage, setSlippage] = useState("2");

  // ── Pool state ─────────────────────────────────────────────────────────────
  const [poolExists, setPoolExists] = useState(false);
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [currentSqrtPriceX96, setCurrentSqrtPriceX96] = useState<bigint | null>(null);
  const [currentTick, setCurrentTick] = useState<number | null>(null);
  const [poolLiquidity, setPoolLiquidity] = useState<bigint>(0n);
  // Sorted token symbols (resolved from actual pool token0/token1 order)
  const [token0Symbol, setToken0Symbol] = useState("");
  const [token1Symbol, setToken1Symbol] = useState("");

  // ── UI state ───────────────────────────────────────────────────────────────
  const [isAdding, setIsAdding] = useState(false);
  const [balanceA, setBalanceA] = useState<bigint | null>(null);
  const [balanceB, setBalanceB] = useState<bigint | null>(null);

  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { toast } = useToast();
  const contracts = chainId ? getContractsForChain(chainId) : null;

  const feeOptions = [
    { value: V3_FEE_TIERS.LOWEST,     label: "0.01%", description: "Very stable pairs" },
    { value: V3_FEE_TIERS.LOW,        label: "0.05%", description: "Stable pairs" },
    { value: V3_FEE_TIERS.MEDIUM,     label: "0.3%",  description: "Most pairs (recommended)" },
    { value: V3_FEE_TIERS.HIGH,       label: "1%",    description: "Exotic/volatile pairs" },
    { value: V3_FEE_TIERS.ULTRA_HIGH, label: "10%",   description: "Very exotic pairs" },
  ];

  // ── Helper: get sorted token pair ─────────────────────────────────────────
  const getSortedTokens = useCallback(() => {
    if (!tokenA || !tokenB || !chainId) return null;
    const erc20A = getERC20Address(tokenA, chainId);
    const erc20B = getERC20Address(tokenB, chainId);
    const [tok0, tok1] = sortTokens(
      { ...tokenA, address: erc20A },
      { ...tokenB, address: erc20B }
    );
    const isToken0A = erc20A.toLowerCase() === tok0.address.toLowerCase();
    return { tok0, tok1, isToken0A };
  }, [tokenA, tokenB, chainId]);

  // ── Deposit mode: derived from current price vs selected range ─────────────
  // token0-only → price BELOW range (only token0 can be deposited)
  // token1-only → price ABOVE range (only token1 can be deposited)
  // dual        → price IN range    (both tokens needed)
  const depositMode = useMemo((): DepositMode => {
    if (currentTick === null || !minTick || !maxTick) return "unknown";
    const tl = parseInt(minTick);
    const tu = parseInt(maxTick);
    if (isNaN(tl) || isNaN(tu) || tl >= tu) return "unknown";
    if (currentTick < tl)  return "token0-only";
    if (currentTick >= tu) return "token1-only";
    return "dual";
  }, [currentTick, minTick, maxTick]);

  // ── Capital efficiency (rough multiplier vs full range) ────────────────────
  const capitalEfficiency = useMemo(() => {
    if (!currentPrice || !minPrice || !maxPrice) return null;
    const minP = parseFloat(minPrice);
    const maxP = parseFloat(maxPrice);
    if (!minP || !maxP || minP <= 0 || maxP <= minP) return null;

    // Uniswap V3 concentrated liquidity efficiency formula:
    // efficiency = sqrt(currentPrice) / (sqrt(currentPrice) - sqrt(minP))
    //            * sqrt(maxP) / (sqrt(maxP) - sqrt(currentPrice))
    // Clamped to a reasonable range for display
    try {
      const sqrtCurrent = Math.sqrt(currentPrice);
      const sqrtMin     = Math.sqrt(minP);
      const sqrtMax     = Math.sqrt(maxP);

      if (sqrtCurrent <= sqrtMin || sqrtCurrent >= sqrtMax) return null;

      const efficiency =
        (sqrtCurrent / (sqrtCurrent - sqrtMin)) *
        (sqrtMax / (sqrtMax - sqrtCurrent));

      return Math.min(Math.round(efficiency), 9999);
    } catch {
      return null;
    }
  }, [currentPrice, minPrice, maxPrice]);

  // ── Load tokens ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!chainId) return;
    const chainTokens = getTokensByChainId(chainId);
    const imported = localStorage.getItem("importedTokens");
    const importedTokens: Token[] = imported ? JSON.parse(imported) : [];
    setTokens([...chainTokens, ...importedTokens.filter((t) => t.chainId === chainId)]);
  }, [chainId]);

  // ── Default tokens ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (tokens.length === 0) return;
    if (!tokenA) {
      const usdc = tokens.find((t) => t.symbol === "USDC");
      if (usdc) setTokenA(usdc);
    }
    if (!tokenB) {
      const achs = tokens.find((t) => t.symbol === "ACHS");
      if (achs) setTokenB(achs);
    }
  }, [tokens, tokenA, tokenB]);

  // ── Import token ───────────────────────────────────────────────────────────
  const handleImportToken = async (addr: string): Promise<Token | null> => {
    try {
      if (!addr || addr.length !== 42 || !addr.startsWith("0x"))
        throw new Error("Invalid token address format");

      const exists = tokens.find((t) => t.address.toLowerCase() === addr.toLowerCase());
      if (exists) {
        toast({ title: "Token already added", description: `${exists.symbol} is already in your list` });
        return exists;
      }

      const rpcUrl = "https://rpc.testnet.arc.network";
      const provider = new BrowserProvider({
        request: async ({ method, params }: any) => {
          const res = await fetch(rpcUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          });
          const data = await res.json();
          if (data.error) throw new Error(data.error.message);
          return data.result;
        },
      });

      const ERC20_META_ABI = [
        "function name() view returns (string)",
        "function symbol() view returns (string)",
        "function decimals() view returns (uint8)",
      ];
      const contract = new Contract(addr, ERC20_META_ABI, provider);
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Request timed out")), 10000)
      );
      const [name, symbol, decimals] = (await Promise.race([
        Promise.all([contract.name(), contract.symbol(), contract.decimals()]),
        timeout,
      ])) as [string, string, bigint];

      if (!chainId) throw new Error("Chain ID not available");

      const newToken: Token = {
        address: addr,
        name,
        symbol,
        decimals: Number(decimals),
        logoURI: "/img/logos/unknown-token.png",
        verified: false,
        chainId,
      };

      const imported = localStorage.getItem("importedTokens");
      const importedTokens: Token[] = imported ? JSON.parse(imported) : [];
      if (!importedTokens.find((t: Token) => t.address.toLowerCase() === addr.toLowerCase())) {
        importedTokens.push(newToken);
        localStorage.setItem("importedTokens", JSON.stringify(importedTokens));
      }
      setTokens((prev) => [...prev, newToken]);
      toast({ title: "Token imported", description: `${symbol} has been added to your token list` });
      return newToken;
    } catch (error: any) {
      const msg = error.message.includes("timeout")
        ? "Request timed out. Please check the address and try again."
        : error.message.includes("Invalid")
          ? error.message
          : "Unable to fetch token data. Please verify the address is correct.";
      toast({ title: "Import failed", description: msg, variant: "destructive" });
      return null;
    }
  };

  // ── Load balances ──────────────────────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      if (!address || !window.ethereum || !tokenA || !tokenB || !chainId) return;
      try {
        const provider = new BrowserProvider(window.ethereum);
        if (isNativeToken(tokenA.address)) {
          setBalanceA(await provider.getBalance(address));
        } else {
          const c = new Contract(getERC20Address(tokenA, chainId), ERC20_ABI, provider);
          setBalanceA(await c.balanceOf(address));
        }
        if (isNativeToken(tokenB.address)) {
          setBalanceB(await provider.getBalance(address));
        } else {
          const c = new Contract(getERC20Address(tokenB, chainId), ERC20_ABI, provider);
          setBalanceB(await c.balanceOf(address));
        }
      } catch (err) {
        console.error("Balance load error:", err);
      }
    };
    load();
  }, [address, tokenA, tokenB, chainId]);

  // ── Check pool ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const checkPool = async () => {
      if (!tokenA || !tokenB || !contracts || !window.ethereum || !chainId) return;
      try {
        const provider = new BrowserProvider(window.ethereum);
        const factory = new Contract(contracts.v3.factory, V3_FACTORY_ABI, provider);
        const sorted = getSortedTokens();
        if (!sorted) return;
        const { tok0, tok1 } = sorted;

        // Store sorted symbols so price labels always match sorted direction
        setToken0Symbol(tok0.symbol);
        setToken1Symbol(tok1.symbol);

        const poolAddress = await factory.getPool(tok0.address, tok1.address, selectedFee);
        const ZERO = "0x0000000000000000000000000000000000000000";

        if (!poolAddress || poolAddress === ZERO) {
          setPoolExists(false);
          setCurrentPrice(null);
          setCurrentSqrtPriceX96(null);
          setCurrentTick(null);
          setPoolLiquidity(0n);
          return;
        }

        setPoolExists(true);
        const pool = new Contract(poolAddress, V3_POOL_ABI, provider);
        const [slot0, liquidity] = await Promise.all([pool.slot0(), pool.liquidity()]);

        const sqrtPriceX96: bigint = slot0[0];
        const tick = Number(slot0[1]);
        const price = sqrtPriceX96ToPrice(sqrtPriceX96, tok0.decimals, tok1.decimals);

        setCurrentSqrtPriceX96(sqrtPriceX96);
        setCurrentPrice(price);
        setCurrentTick(tick);
        setPoolLiquidity(liquidity);

        // Set default wide range if nothing has been entered yet
        if (!minPrice && !maxPrice) {
          applyRangePresetValues("wide", price, tick, tok0, tok1);
        }
      } catch (err) {
        console.error("Pool check error:", err);
        setPoolExists(false);
      }
    };
    checkPool();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenA, tokenB, selectedFee, contracts, chainId]);

  // ── Amount B auto-calculation (V3 liquidity math, tick-range aware) ────────
  //
  // V3 positions are NOT always 50/50. The ratio depends on WHERE the current
  // price sits within [tickLower, tickUpper]:
  //   • price BELOW range  → deposit token0 only, amount1 = 0
  //   • price ABOVE range  → deposit token1 only, amount0 = 0
  //   • price IN range     → both tokens needed in the exact V3 ratio
  //
  // We use calculateAmountsForLiquidity() for the in-range case, which is the
  // same math the NonfungiblePositionManager uses on-chain.
  useEffect(() => {
    if (!amountA || !tokenA || !tokenB || !chainId) return;
    const amountAFloat = parseFloat(amountA);
    if (isNaN(amountAFloat) || amountAFloat <= 0) { setAmountB(""); return; }

    const sorted = getSortedTokens();
    if (!sorted) return;
    const { tok0, tok1, isToken0A } = sorted;

    const tl = minTick ? parseInt(minTick) : null;
    const tu = maxTick ? parseInt(maxTick) : null;
    const validTicks = tl !== null && tu !== null && !isNaN(tl) && !isNaN(tu) && tl < tu;

    // ── Out-of-range: single-sided deposit ────────────────────────────────
    if (validTicks && currentTick !== null) {
      if (currentTick < tl!) {
        // Price below range → only token0. If tokenA IS token0, amountB = 0.
        if (isToken0A) { setAmountB("0"); return; }
        // If tokenA is token1 (user is entering token1), we can't deposit it here.
        setAmountB("0");
        return;
      }
      if (currentTick >= tu!) {
        // Price above range → only token1. If tokenA IS token1, amountB = 0.
        if (!isToken0A) { setAmountB("0"); return; }
        setAmountB("0");
        return;
      }
    }

    // ── In-range: use V3 liquidity math ───────────────────────────────────
    if (validTicks && currentSqrtPriceX96) {
      try {
        const inputBig = parseAmount(amountA, isToken0A ? tokenA.decimals : tokenB.decimals);
        const { amount0, amount1 } = calculateAmountsForLiquidity(
          inputBig,
          isToken0A,
          currentSqrtPriceX96,
          tl!,
          tu!,
          tok0.decimals,
          tok1.decimals
        );
        const counterpart    = isToken0A ? amount1 : amount0;
        const counterpartDec = isToken0A ? tok1.decimals : tok0.decimals;
        setAmountB(parseFloat(formatUnits(counterpart, counterpartDec)).toFixed(6));
        return;
      } catch (err) {
        console.warn("V3 math fallback to spot price:", err);
      }
    }

    // ── Fallback: spot price ───────────────────────────────────────────────
    if (currentPrice) {
      const calc = isToken0A ? amountAFloat * currentPrice : amountAFloat / currentPrice;
      setAmountB(calc.toFixed(6));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountA, minTick, maxTick, currentSqrtPriceX96, currentPrice, currentTick, tokenA, tokenB, chainId]);

  // ── Price ↔ Tick one-way handlers (no feedback loop) ──────────────────────
  //
  // Each handler only writes in ONE direction: price → tick, or tick → price.
  // We do NOT have a useEffect that watches both sides simultaneously — that
  // caused the old code to bounce back and forth between two states.

  const handleMinPriceChange = (value: string) => {
    setMinPrice(value);
    const p = parseFloat(value);
    if (isNaN(p) || p <= 0) return;
    const s = getSortedTokens();
    if (!s) return;
    const t = getNearestUsableTick(priceToTick(p, s.tok0.decimals, s.tok1.decimals), getTickSpacing(selectedFee));
    setMinTick(t.toString());
  };

  const handleMaxPriceChange = (value: string) => {
    setMaxPrice(value);
    const p = parseFloat(value);
    if (isNaN(p) || p <= 0) return;
    const s = getSortedTokens();
    if (!s) return;
    const t = getNearestUsableTick(priceToTick(p, s.tok0.decimals, s.tok1.decimals), getTickSpacing(selectedFee));
    setMaxTick(t.toString());
  };

  const handleMinTickChange = (value: string) => {
    setMinTick(value);
    const t = parseInt(value);
    if (isNaN(t)) return;
    const s = getSortedTokens();
    if (!s) return;
    setMinPrice(tickToPrice(t, s.tok0.decimals, s.tok1.decimals).toFixed(6));
  };

  const handleMaxTickChange = (value: string) => {
    setMaxTick(value);
    const t = parseInt(value);
    if (isNaN(t)) return;
    const s = getSortedTokens();
    if (!s) return;
    setMaxPrice(tickToPrice(t, s.tok0.decimals, s.tok1.decimals).toFixed(6));
  };

  // ── Range preset helper ────────────────────────────────────────────────────
  // Separated from the button click handler so checkPool() can also call it
  // with freshly-fetched pool data before the state has updated.
  const applyRangePresetValues = useCallback(
    (
      preset: "full" | "wide" | "narrow" | "current",
      price: number,
      tick: number,
      tok0: Token & { address: string; decimals: number },
      tok1: Token & { address: string; decimals: number }
    ) => {
      const tickSpacing = getTickSpacing(selectedFee);

      if (preset === "full") {
        const { tickLower, tickUpper } = getFullRangeTicks(selectedFee);
        setMinTick(tickLower.toString());
        setMaxTick(tickUpper.toString());
        setMinPrice(tickToPrice(tickLower, tok0.decimals, tok1.decimals).toFixed(10));
        setMaxPrice(tickToPrice(tickUpper, tok0.decimals, tok1.decimals).toFixed(10));
        return;
      }

      if (preset === "wide") {
        const lp = price * 0.5;
        const up = price * 2;
        const tl = getNearestUsableTick(priceToTick(lp, tok0.decimals, tok1.decimals), tickSpacing);
        const tu = getNearestUsableTick(priceToTick(up, tok0.decimals, tok1.decimals), tickSpacing);
        setMinTick(tl.toString()); setMaxTick(tu.toString());
        setMinPrice(lp.toFixed(6)); setMaxPrice(up.toFixed(6));
        return;
      }

      if (preset === "narrow") {
        const lp = price * 0.9;
        const up = price * 1.1;
        let tl = getNearestUsableTick(priceToTick(lp, tok0.decimals, tok1.decimals), tickSpacing);
        let tu = getNearestUsableTick(priceToTick(up, tok0.decimals, tok1.decimals), tickSpacing);

        // Guard: if tickSpacing is so large that ±10% collapses to the same tick,
        // force a minimum 2-spacing range around current tick instead.
        if (tl >= tu) {
          const centTick = getNearestUsableTick(tick, tickSpacing);
          tl = centTick - tickSpacing;
          tu = centTick + tickSpacing;
        }

        setMinTick(tl.toString()); setMaxTick(tu.toString());
        setMinPrice(tickToPrice(tl, tok0.decimals, tok1.decimals).toFixed(6));
        setMaxPrice(tickToPrice(tu, tok0.decimals, tok1.decimals).toFixed(6));
        return;
      }

      if (preset === "current") {
        // One tick-spacing wide, centred on current tick.
        // This is intentionally a single-sided (or near single-sided) position.
        const centTick = getNearestUsableTick(tick, tickSpacing);
        const tl = centTick;
        const tu = centTick + tickSpacing;
        setMinTick(tl.toString()); setMaxTick(tu.toString());
        setMinPrice(tickToPrice(tl, tok0.decimals, tok1.decimals).toFixed(6));
        setMaxPrice(tickToPrice(tu, tok0.decimals, tok1.decimals).toFixed(6));
      }
    },
    [selectedFee]
  );

  const applyRangePreset = (preset: "full" | "wide" | "narrow" | "current") => {
    if (!currentPrice || currentTick === null || !tokenA || !tokenB || !chainId) return;
    const s = getSortedTokens();
    if (!s) return;
    applyRangePresetValues(preset, currentPrice, currentTick, s.tok0 as any, s.tok1 as any);
  };

  // ── Native token flags ─────────────────────────────────────────────────────
  const needsWrapA = tokenA ? isNativeToken(tokenA.address) : false;
  const needsWrapB = tokenB ? isNativeToken(tokenB.address) : false;
  const needsWrapping = needsWrapA || needsWrapB;

  // ── In-range check ─────────────────────────────────────────────────────────
  const isInRange =
    currentTick !== null && minTick && maxTick
      ? isPositionInRange(currentTick, parseInt(minTick), parseInt(maxTick))
      : null;

  // ── Add liquidity ──────────────────────────────────────────────────────────
  const handleAddLiquidity = async () => {
    if (!tokenA || !tokenB || !address || !contracts || !window.ethereum || !chainId) return;

    // Validate tick range
    const tickLowerRaw = parseInt(minTick);
    const tickUpperRaw = parseInt(maxTick);
    if (isNaN(tickLowerRaw) || isNaN(tickUpperRaw) || tickLowerRaw >= tickUpperRaw) {
      toast({
        title: "Invalid price range",
        description: "Min price must be less than max price",
        variant: "destructive",
      });
      return;
    }

    // Validate amounts depending on deposit mode
    if (depositMode === "dual" && (!amountA || parseFloat(amountA) <= 0)) {
      toast({ title: "Enter an amount", description: "Amount A is required", variant: "destructive" });
      return;
    }
    if (depositMode === "token1-only" && (!amountB || parseFloat(amountB) <= 0)) {
      toast({ title: "Enter an amount", description: `Enter an amount for ${token1Symbol}`, variant: "destructive" });
      return;
    }

    setIsAdding(true);
    try {
      const provider = new BrowserProvider(window.ethereum);
      const signer   = await provider.getSigner();

      const positionManager = new Contract(
        contracts.v3.nonfungiblePositionManager,
        NONFUNGIBLE_POSITION_MANAGER_ABI,
        signer
      );

      const tokenAIsNative = isNativeToken(tokenA.address);
      const tokenBIsNative = isNativeToken(tokenB.address);
      const tokenAERC20   = getERC20Address(tokenA, chainId);
      const tokenBERC20   = getERC20Address(tokenB, chainId);

      const [token0, token1] = sortTokens(
        { ...tokenA, address: tokenAERC20 },
        { ...tokenB, address: tokenBERC20 }
      );
      const isToken0A = tokenAERC20.toLowerCase() === token0.address.toLowerCase();

      // ── Compute desired amounts, honouring out-of-range single-sided rules ─
      let amount0Desired: bigint;
      let amount1Desired: bigint;

      if (depositMode === "token0-only") {
        // Current price below range → only token0 accepted
        amount0Desired = parseAmount(isToken0A ? amountA : amountB, token0.decimals);
        amount1Desired = 0n;
      } else if (depositMode === "token1-only") {
        // Current price above range → only token1 accepted
        amount0Desired = 0n;
        amount1Desired = parseAmount(isToken0A ? amountB : amountA, token1.decimals);
      } else {
        // Both tokens (in-range or unknown)
        amount0Desired = parseAmount(isToken0A ? amountA : amountB, token0.decimals);
        amount1Desired = parseAmount(isToken0A ? amountB : amountA, token1.decimals);
      }

      // ── Native value to send ───────────────────────────────────────────────
      let nativeAmount = 0n;
      if (tokenAIsNative) {
        nativeAmount = isToken0A ? amount0Desired : amount1Desired;
      } else if (tokenBIsNative) {
        nativeAmount = isToken0A ? amount1Desired : amount0Desired;
      }

      // ── Snap ticks to tickSpacing ──────────────────────────────────────────
      const tickSpacing = getTickSpacing(selectedFee);
      const tickLower   = getNearestUsableTick(tickLowerRaw, tickSpacing);
      const tickUpper   = getNearestUsableTick(tickUpperRaw, tickSpacing);

      if (tickLower >= tickUpper) {
        toast({ title: "Invalid tick range", description: "Ticks collapsed after snapping to spacing", variant: "destructive" });
        return;
      }

      // ── Create pool if needed ──────────────────────────────────────────────
      if (!poolExists) {
        const midPrice = (parseFloat(minPrice) + parseFloat(maxPrice)) / 2;
        const sqrtPriceX96 = priceToSqrtPriceX96(midPrice, token0.decimals, token1.decimals);

        toast({ title: "Creating pool…", description: "Initializing new V3 pool" });

        if (nativeAmount > 0n) {
          const createData = positionManager.interface.encodeFunctionData(
            "createAndInitializePoolIfNecessary",
            [token0.address, token1.address, selectedFee, sqrtPriceX96]
          );
          const refundData = positionManager.interface.encodeFunctionData("refundETH", []);
          const tx = await positionManager.multicall([createData, refundData], { value: nativeAmount });
          await tx.wait();
        } else {
          const tx = await positionManager.createAndInitializePoolIfNecessary(
            token0.address, token1.address, selectedFee, sqrtPriceX96
          );
          await tx.wait();
        }
      }

      // ── Approve ERC-20 tokens ──────────────────────────────────────────────
      toast({ title: "Approving tokens…", description: "Please approve token spending" });

      const needsApproveToken0 = amount0Desired > 0n && !(tokenAIsNative && isToken0A) && !(tokenBIsNative && !isToken0A);
      const needsApproveToken1 = amount1Desired > 0n && !(tokenAIsNative && !isToken0A) && !(tokenBIsNative && isToken0A);

      if (needsApproveToken0) {
        const c0 = new Contract(token0.address, ERC20_ABI, signer);
        const allowance0 = await c0.allowance(address, contracts.v3.nonfungiblePositionManager);
        if (allowance0 < amount0Desired) {
          await (await c0.approve(contracts.v3.nonfungiblePositionManager, amount0Desired)).wait();
        }
      }

      if (needsApproveToken1) {
        const c1 = new Contract(token1.address, ERC20_ABI, signer);
        const allowance1 = await c1.allowance(address, contracts.v3.nonfungiblePositionManager);
        if (allowance1 < amount1Desired) {
          await (await c1.approve(contracts.v3.nonfungiblePositionManager, amount1Desired)).wait();
        }
      }

      // ── Slippage minimums ──────────────────────────────────────────────────
      // For out-of-range (single-sided) positions the unused token is 0 anyway,
      // so its minimum stays 0. Only apply slippage to the deposited token.
      const slippagePercent = parseFloat(slippage) || 2;
      const slippageFactor  = BigInt(Math.floor((100 - slippagePercent) * 100));
      const amount0Min = amount0Desired > 0n ? (amount0Desired * slippageFactor) / 10000n : 0n;
      const amount1Min = amount1Desired > 0n ? (amount1Desired * slippageFactor) / 10000n : 0n;
      const deadline   = Math.floor(Date.now() / 1000) + 1200;

      toast({ title: "Adding liquidity…", description: "Creating your V3 position" });

      const params = {
        token0: token0.address,
        token1: token1.address,
        fee: selectedFee,
        tickLower,
        tickUpper,
        amount0Desired,
        amount1Desired,
        amount0Min,
        amount1Min,
        recipient: address,
        deadline,
      };

      let receipt;
      if (nativeAmount > 0n) {
        const mintData   = positionManager.interface.encodeFunctionData("mint", [params]);
        const refundData = positionManager.interface.encodeFunctionData("refundETH", []);
        const gasEst  = await positionManager.multicall.estimateGas([mintData, refundData], { value: nativeAmount });
        const gasLimit = (gasEst * 150n) / 100n;
        const tx = await positionManager.multicall([mintData, refundData], { value: nativeAmount, gasLimit });
        receipt = await tx.wait();
      } else {
        const gasEst  = await positionManager.mint.estimateGas(params);
        const gasLimit = (gasEst * 150n) / 100n;
        const tx = await positionManager.mint(params, { gasLimit });
        receipt = await tx.wait();
      }

      setAmountA("");
      setAmountB("");

      toast({
        title: "Liquidity added! 🎉",
        description: (
          <div className="flex items-center gap-2">
            <span>V3 position created</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2"
              onClick={() => window.open(`${contracts.explorer}${receipt.hash}`, "_blank")}
            >
              <ExternalLink className="h-3 w-3" />
            </Button>
          </div>
        ),
      });
    } catch (error: any) {
      console.error("Add liquidity error:", error);
      toast({
        title: "Failed to add liquidity",
        description: error.reason || error.message || "Transaction failed",
        variant: "destructive",
      });
    } finally {
      setIsAdding(false);
    }
  };

  // ── UI helpers ─────────────────────────────────────────────────────────────
  // What the "Add" button should say
  const addButtonLabel = () => {
    if (isAdding) return "Adding Liquidity…";
    if (depositMode === "token0-only")
      return `Add ${token0Symbol || tokenA?.symbol || "Token0"} Only (Out of Range)`;
    if (depositMode === "token1-only")
      return `Add ${token1Symbol || tokenB?.symbol || "Token1"} Only (Out of Range)`;
    return "Add V3 Liquidity (Advanced)";
  };

  // Price range label direction: always "token1 per token0" (sorted)
  const priceLabel = token0Symbol && token1Symbol
    ? `${token1Symbol} per ${token0Symbol}`
    : tokenA && tokenB
      ? `${tokenB.symbol} / ${tokenA.symbol}`
      : "Price";

  return (
    <div className="space-y-4">
      {/* ── Warning Banner ────────────────────────────────────────────────── */}
      <div className="flex items-start gap-3 p-4 bg-orange-500/10 border border-orange-500/20 rounded-lg">
        <AlertTriangle className="h-5 w-5 text-orange-400 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <h3 className="font-semibold text-orange-400 text-sm">Advanced Mode – Full Control</h3>
          <p className="text-xs text-slate-300">
            You control exact price ranges, ticks, and slippage. Out-of-range positions deposit
            only one token and earn no fees until the price re-enters the range.
          </p>
        </div>
      </div>

      {/* ── Token Inputs ──────────────────────────────────────────────────── */}
      <Card className="bg-slate-900 border-slate-700">
        <CardContent className="p-6 space-y-4">
          {/* Token A */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm text-slate-400">
                {token0Symbol && tokenA
                  ? tokenA.symbol === token0Symbol
                    ? `Token A (token0 · ${token0Symbol})`
                    : `Token A (token1 · ${tokenA.symbol})`
                  : "Token A"}
              </Label>
              {balanceA !== null && tokenA && (
                <button
                  className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                  onClick={() => setAmountA(formatAmount(balanceA, tokenA.decimals))}
                >
                  Balance: {formatAmount(balanceA, tokenA.decimals)} MAX
                </button>
              )}
            </div>
            <div className="flex gap-2">
              <Input
                type="number"
                placeholder="0.00"
                value={amountA}
                onChange={(e) => setAmountA(e.target.value)}
                className="flex-1 bg-slate-800 border-slate-600"
                disabled={depositMode === "token1-only"}
              />
              <Button
                variant="outline"
                onClick={() => setShowTokenASelector(true)}
                className="min-w-[120px]"
              >
                {tokenA ? (
                  <div className="flex items-center gap-2">
                    {tokenA.logoURI && (
                      <img src={tokenA.logoURI} alt={tokenA.symbol} className="w-5 h-5 rounded-full" />
                    )}
                    <span>{tokenA.symbol}</span>
                  </div>
                ) : (
                  "Select Token"
                )}
              </Button>
            </div>
            {depositMode === "token1-only" && (
              <p className="text-xs text-amber-400">
                ⚠ Price is above range — only {token1Symbol || tokenB?.symbol} will be deposited
              </p>
            )}
          </div>

          {/* Token B */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm text-slate-400">
                {token1Symbol && tokenB
                  ? tokenB.symbol === token1Symbol
                    ? `Token B (token1 · ${token1Symbol})`
                    : `Token B (token0 · ${tokenB.symbol})`
                  : "Token B"}
              </Label>
              {balanceB !== null && tokenB && (
                <button
                  className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                  onClick={() => setAmountB(formatAmount(balanceB, tokenB.decimals))}
                >
                  Balance: {formatAmount(balanceB, tokenB.decimals)} MAX
                </button>
              )}
            </div>
            <div className="flex gap-2">
              <Input
                type="number"
                placeholder="0.00"
                value={amountB}
                onChange={(e) => setAmountB(e.target.value)}
                className="flex-1 bg-slate-800 border-slate-600"
                // Auto-calculated from V3 math when pool exists
                disabled={depositMode === "token0-only" || (poolExists && depositMode === "dual")}
              />
              <Button
                variant="outline"
                onClick={() => setShowTokenBSelector(true)}
                className="min-w-[120px]"
              >
                {tokenB ? (
                  <div className="flex items-center gap-2">
                    {tokenB.logoURI && (
                      <img src={tokenB.logoURI} alt={tokenB.symbol} className="w-5 h-5 rounded-full" />
                    )}
                    <span>{tokenB.symbol}</span>
                  </div>
                ) : (
                  "Select Token"
                )}
              </Button>
            </div>
            {depositMode === "token0-only" && (
              <p className="text-xs text-amber-400">
                ⚠ Price is below range — only {token0Symbol || tokenA?.symbol} will be deposited
              </p>
            )}
            {depositMode === "dual" && poolExists && (
              <p className="text-xs text-slate-500">
                Auto-calculated from V3 liquidity math
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── Fee Tier ──────────────────────────────────────────────────────── */}
      <Card className="bg-slate-900 border-slate-700">
        <CardContent className="p-6 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Label className="text-sm text-slate-400">Fee Tier</Label>
              <Info className="h-4 w-4 text-slate-500" />
            </div>
            {poolExists && (
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <BarChart3 className="h-3 w-3" />
                <span>Liquidity: {formatAmount(poolLiquidity, 18)}</span>
              </div>
            )}
          </div>
          <div className="flex gap-2 flex-wrap">
            {feeOptions.map((option) => (
              <Button
                key={option.value}
                variant={selectedFee === option.value ? "default" : "outline"}
                onClick={() => setSelectedFee(option.value)}
                className="flex-1 min-w-[72px] flex-col h-auto py-2 text-xs"
                title={option.description}
              >
                <span className="font-semibold text-sm">{option.label}</span>
                <span className="opacity-60 text-[10px] leading-tight">{option.description}</span>
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ── Price Range ───────────────────────────────────────────────────── */}
      <Card className="bg-slate-900 border-slate-700">
        <CardContent className="p-6 space-y-4">

          {/* Mode toggle + current price */}
          <div className="flex items-center justify-between">
            <div className="flex gap-2">
              <Button
                variant={!useTickMode ? "default" : "outline"}
                size="sm"
                onClick={() => setUseTickMode(false)}
              >
                Price
              </Button>
              <Button
                variant={useTickMode ? "default" : "outline"}
                size="sm"
                onClick={() => setUseTickMode(true)}
              >
                Ticks
              </Button>
            </div>
            {poolExists && currentPrice !== null && (
              <div className="text-right">
                <p className="text-xs text-slate-400">
                  Current: <span className="text-white font-mono">{currentPrice.toFixed(6)}</span>
                </p>
                <p className="text-xs text-slate-500">
                  {priceLabel} · tick {currentTick}
                </p>
              </div>
            )}
          </div>

          {/* Range presets */}
          {poolExists && currentPrice !== null && (
            <div className="space-y-2">
              <Label className="text-xs text-slate-500">Quick Range Presets</Label>
              <div className="grid grid-cols-4 gap-2">
                {(
                  [
                    { key: "full", label: "Full Range", icon: Layers, tip: "Max range, lowest IL risk, lowest fee efficiency" },
                    { key: "wide", label: "Wide ±50%", icon: TrendingUp, tip: "0.5x–2x current price" },
                    { key: "narrow", label: "Narrow ±10%", icon: Target, tip: "90%–110% of current price, high efficiency" },
                    { key: "current", label: "At Current", icon: Activity, tip: `One tick-spacing wide at current price (tick spacing: ${getTickSpacing(selectedFee)})` },
                  ] as const
                ).map(({ key, label, icon: Icon, tip }) => (
                  <Button
                    key={key}
                    variant="outline"
                    size="sm"
                    onClick={() => applyRangePreset(key)}
                    title={tip}
                    className="flex flex-col h-auto py-2 text-xs gap-1"
                  >
                    <Icon className="h-3 w-3" />
                    <span>{label}</span>
                  </Button>
                ))}
              </div>
            </div>
          )}

          {/* Price / Tick inputs */}
          {!useTickMode ? (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-xs text-slate-500">Min Price ({priceLabel})</Label>
                <div className="relative">
                  <Input
                    type="number"
                    placeholder="0.00"
                    value={minPrice}
                    onChange={(e) => handleMinPriceChange(e.target.value)}
                    className="bg-slate-800 border-slate-600 pr-8"
                  />
                  <TrendingDown className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500 pointer-events-none" />
                </div>
                {minTick && <p className="text-xs text-slate-600 font-mono">tick: {minTick}</p>}
              </div>
              <div className="space-y-2">
                <Label className="text-xs text-slate-500">Max Price ({priceLabel})</Label>
                <div className="relative">
                  <Input
                    type="number"
                    placeholder="0.00"
                    value={maxPrice}
                    onChange={(e) => handleMaxPriceChange(e.target.value)}
                    className="bg-slate-800 border-slate-600 pr-8"
                  />
                  <TrendingUp className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500 pointer-events-none" />
                </div>
                {maxTick && <p className="text-xs text-slate-600 font-mono">tick: {maxTick}</p>}
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-xs text-slate-500">
                  Tick Lower <span className="text-slate-600">(spacing: {getTickSpacing(selectedFee)})</span>
                </Label>
                <Input
                  type="number"
                  placeholder="-887272"
                  value={minTick}
                  onChange={(e) => handleMinTickChange(e.target.value)}
                  className="bg-slate-800 border-slate-600"
                />
                {minPrice && <p className="text-xs text-slate-600">≈ {parseFloat(minPrice).toFixed(6)}</p>}
              </div>
              <div className="space-y-2">
                <Label className="text-xs text-slate-500">
                  Tick Upper <span className="text-slate-600">(spacing: {getTickSpacing(selectedFee)})</span>
                </Label>
                <Input
                  type="number"
                  placeholder="887272"
                  value={maxTick}
                  onChange={(e) => handleMaxTickChange(e.target.value)}
                  className="bg-slate-800 border-slate-600"
                />
                {maxPrice && <p className="text-xs text-slate-600">≈ {parseFloat(maxPrice).toFixed(6)}</p>}
              </div>
            </div>
          )}

          {/* Price Range Chart */}
          {tokenA && tokenB && minPrice && maxPrice &&
            parseFloat(minPrice) > 0 && parseFloat(maxPrice) > 0 && (
            <PriceRangeChart
              minPrice={parseFloat(minPrice)}
              maxPrice={parseFloat(maxPrice)}
              currentPrice={currentPrice || undefined}
              token0Symbol={token0Symbol || tokenA.symbol}
              token1Symbol={token1Symbol || tokenB.symbol}
            />
          )}

          {/* Capital Efficiency */}
          {capitalEfficiency !== null && depositMode === "dual" && (
            <div className="flex items-center justify-between p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg">
              <div className="flex items-center gap-2 text-sm text-blue-400">
                <Zap className="h-4 w-4" />
                <span>Capital Efficiency</span>
              </div>
              <div className="text-right">
                <span className="text-lg font-bold text-blue-300">{capitalEfficiency}x</span>
                <p className="text-xs text-slate-500">vs full range</p>
              </div>
            </div>
          )}

          {/* Range Status */}
          {poolExists && isInRange !== null && minTick && maxTick && (
            <div
              className={`p-3 rounded-lg border ${
                isInRange
                  ? "bg-green-500/10 border-green-500/20 text-green-400"
                  : "bg-amber-500/10 border-amber-500/20 text-amber-400"
              }`}
            >
              <div className="flex items-center gap-2 text-sm font-medium">
                {isInRange ? (
                  <>
                    <Zap className="h-4 w-4" />
                    <span>In Range — will earn fees immediately</span>
                  </>
                ) : (
                  <>
                    <AlertTriangle className="h-4 w-4" />
                    <span>Out of Range — no fees until price moves into range</span>
                  </>
                )}
              </div>
              {!isInRange && (
                <p className="text-xs mt-1 opacity-80">
                  {depositMode === "token0-only"
                    ? `Only ${token0Symbol} will be deposited. Earns fees when price rises above ${parseFloat(minPrice).toFixed(4)}.`
                    : `Only ${token1Symbol} will be deposited. Earns fees when price falls below ${parseFloat(maxPrice).toFixed(4)}.`}
                </p>
              )}
            </div>
          )}

          {/* Tick spacing info */}
          {!poolExists && tokenA && tokenB && (
            <div className="flex items-start gap-2 p-3 bg-slate-800/50 border border-slate-700 rounded-lg">
              <Info className="h-4 w-4 text-slate-400 shrink-0 mt-0.5" />
              <p className="text-xs text-slate-400">
                No pool exists yet — it will be created with the mid-price of your range.
                Tick spacing for this fee tier: <span className="font-mono text-slate-300">{getTickSpacing(selectedFee)}</span>.
                Ticks must be divisible by this value.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Slippage Settings ─────────────────────────────────────────────── */}
      <Card className="bg-slate-900 border-slate-700">
        <CardContent className="p-6 space-y-3">
          <div className="flex items-center gap-2">
            <Settings className="h-4 w-4 text-slate-400" />
            <Label className="text-sm text-slate-400">Slippage Tolerance</Label>
          </div>
          <div className="flex gap-2 items-center flex-wrap">
            {["0.5", "1", "2", "5"].map((s) => (
              <Button
                key={s}
                variant={slippage === s ? "default" : "outline"}
                size="sm"
                onClick={() => setSlippage(s)}
              >
                {s}%
              </Button>
            ))}
            <div className="flex items-center gap-1 ml-auto">
              <Input
                type="number"
                value={slippage}
                onChange={(e) => setSlippage(e.target.value)}
                className="w-20 bg-slate-800 border-slate-600"
                min="0"
                max="50"
                step="0.1"
              />
              <span className="text-sm text-slate-400">%</span>
            </div>
          </div>
          {parseFloat(slippage) > 10 && (
            <p className="text-xs text-amber-400">⚠ High slippage — your position may be front-run</p>
          )}
        </CardContent>
      </Card>

      {/* ── Wrapping Notice ───────────────────────────────────────────────── */}
      {needsWrapping && tokenA && tokenB && (
        <div className="flex items-start gap-3 p-4 bg-green-500/10 border border-green-500/20 rounded-lg">
          <Shield className="h-5 w-5 text-green-400 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <h3 className="font-semibold text-green-400 text-sm">Automatic Native Token Wrapping</h3>
            <p className="text-xs text-slate-300">
              Your native {needsWrapA ? tokenA.symbol : tokenB.symbol} is wrapped automatically in a single
              transaction via multicall + refundETH. No pre-wrapping needed.
            </p>
          </div>
        </div>
      )}

      {/* ── Add Button ────────────────────────────────────────────────────── */}
      {isConnected ? (
        <Button
          onClick={handleAddLiquidity}
          disabled={
            !tokenA ||
            !tokenB ||
            !minPrice ||
            !maxPrice ||
            isAdding ||
            parseInt(minTick) >= parseInt(maxTick) ||
            (depositMode !== "token1-only" && (!amountA || parseFloat(amountA) <= 0)) ||
            (depositMode === "token1-only" && (!amountB || parseFloat(amountB) <= 0))
          }
          className="w-full h-12 text-base font-semibold"
        >
          {addButtonLabel()}
        </Button>
      ) : (
        <Button disabled className="w-full h-12">
          Connect Wallet
        </Button>
      )}

      {/* ── Token Selectors ───────────────────────────────────────────────── */}
      <TokenSelector
        open={showTokenASelector}
        onClose={() => setShowTokenASelector(false)}
        onSelect={(token) => { setTokenA(token); setShowTokenASelector(false); }}
        tokens={tokens}
        onImport={handleImportToken}
      />
      <TokenSelector
        open={showTokenBSelector}
        onClose={() => setShowTokenBSelector(false)}
        onSelect={(token) => { setTokenB(token); setShowTokenBSelector(false); }}
        tokens={tokens}
        onImport={handleImportToken}
      />
    </div>
  );
}
