import { useState, useEffect, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TokenSelector } from "@/components/TokenSelector";
import { useAccount, useChainId } from "wagmi";
import { useToast } from "@/hooks/use-toast";
import type { Token } from "@shared/schema";
import { Contract, BrowserProvider, parseUnits } from "ethers";
import { getTokensByChainId, isNativeToken, getWrappedAddress } from "@/data/tokens";
import { formatAmount, parseAmount } from "@/lib/decimal-utils";
import { getContractsForChain } from "@/lib/contracts";
import { NONFUNGIBLE_POSITION_MANAGER_ABI, V3_FACTORY_ABI, V3_POOL_ABI, V3_FEE_TIERS, FEE_TIER_LABELS } from "@/lib/abis/v3";
import { priceToSqrtPriceX96, getWideRangeTicks, sortTokens, getPriceFromAmounts, sqrtPriceX96ToPrice, getFullRangeTicks } from "@/lib/v3-utils";
import { calculateAmountsForLiquidity } from "@/lib/v3-liquidity-math";
import { PoolHealthChecker } from "@/components/PoolHealthChecker";
import type { PoolHealthResult } from "@/components/PoolHealthChecker";
import { AlertTriangle, Info, Shield, ExternalLink } from "lucide-react";

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

/**
 * Get the ERC20 address for a token - if native, return wrapped address
 */
function getERC20Address(token: Token, chainId: number): string {
  if (isNativeToken(token.address)) {
    const wrapped = getWrappedAddress(chainId, token.address);
    return wrapped || token.address;
  }
  return token.address;
}

export function AddLiquidityV3Basic() {
  const [tokenA, setTokenA] = useState<Token | null>(null);
  const [tokenB, setTokenB] = useState<Token | null>(null);
  const [amountA, setAmountA] = useState("");
  const [amountB, setAmountB] = useState("");
  const [showTokenASelector, setShowTokenASelector] = useState(false);
  const [showTokenBSelector, setShowTokenBSelector] = useState(false);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [selectedFee, setSelectedFee] = useState<number>(V3_FEE_TIERS.MEDIUM);
  const [isAdding, setIsAdding] = useState(false);
  const [poolExists, setPoolExists] = useState(false);
  const [isCheckingPool, setIsCheckingPool] = useState(false);
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [currentSqrtPriceX96, setCurrentSqrtPriceX96] = useState<bigint | null>(null);
  const [currentTick, setCurrentTick] = useState<number | null>(null);

  // ── Pool health state ──────────────────────────────────────────────────────
  const [poolHealth, setPoolHealth] = useState<PoolHealthResult | null>(null);

  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { toast } = useToast();

  const contracts = chainId ? getContractsForChain(chainId) : null;

  // Fee tier options
  const feeOptions = [
    { value: V3_FEE_TIERS.LOWEST,    label: "0.01%", description: "Best for very stable pairs" },
    { value: V3_FEE_TIERS.LOW,       label: "0.05%", description: "Best for stable pairs" },
    { value: V3_FEE_TIERS.MEDIUM,    label: "0.3%",  description: "Best for most pairs" },
    { value: V3_FEE_TIERS.HIGH,      label: "1%",    description: "Best for exotic pairs" },
    { value: V3_FEE_TIERS.ULTRA_HIGH,label: "10%",   description: "Best for very exotic pairs" },
  ];

  // ── Derive expected price ratio from user inputs ───────────────────────────
  // Used by PoolHealthChecker for mismatch detection + auto-fix initialisation
  const expectedPriceRatio = useMemo(() => {
    if (!tokenA || !tokenB || !amountA || !amountB || !chainId) return null;
    const a = parseFloat(amountA);
    const b = parseFloat(amountB);
    if (!a || !b || isNaN(a) || isNaN(b)) return null;

    const erc20A = getERC20Address(tokenA, chainId);
    const erc20B = getERC20Address(tokenB, chainId);
    const tokenAForPool = { ...tokenA, address: erc20A };
    const tokenBForPool = { ...tokenB, address: erc20B };
    const [tok0] = sortTokens(tokenAForPool, tokenBForPool);
    const isToken0A = erc20A.toLowerCase() === tok0.address.toLowerCase();
    // V3 pool price is always token1/token0 in sorted order
    return isToken0A ? b / a : a / b;
  }, [tokenA, tokenB, amountA, amountB, chainId]);

  // Load tokens
  useEffect(() => {
    if (!chainId) return;
    const chainTokens = getTokensByChainId(chainId);

    // Load imported tokens from localStorage
    const imported = localStorage.getItem("importedTokens");
    const importedTokens: Token[] = imported ? JSON.parse(imported) : [];
    const chainImportedTokens = importedTokens.filter((t) => t.chainId === chainId);

    setTokens([...chainTokens, ...chainImportedTokens]);
  }, [chainId]);

  const handleImportToken = async (address: string): Promise<Token | null> => {
    try {
      if (!address || address.length !== 42 || !address.startsWith("0x")) {
        throw new Error("Invalid token address format");
      }

      const exists = tokens.find((t) => t.address.toLowerCase() === address.toLowerCase());
      if (exists) {
        toast({ title: "Token already added", description: `${exists.symbol} is already in your token list` });
        return exists;
      }

      const rpcUrl = "https://rpc.testnet.arc.network";
      const provider = new BrowserProvider({
        request: async ({ method, params }: any) => {
          const response = await fetch(rpcUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          });
          const data = await response.json();
          if (data.error) throw new Error(data.error.message);
          return data.result;
        },
      });

      const ERC20_META_ABI = [
        "function name() view returns (string)",
        "function symbol() view returns (string)",
        "function decimals() view returns (uint8)",
      ];

      const contract = new Contract(address, ERC20_META_ABI, provider);
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Request timed out")), 10000)
      );

      const [name, symbol, decimals] = await Promise.race([
        Promise.all([contract.name(), contract.symbol(), contract.decimals()]),
        timeout,
      ]) as [string, string, bigint];

      if (!chainId) throw new Error("Chain ID not available");

      const newToken: Token = {
        address,
        name,
        symbol,
        decimals: Number(decimals),
        logoURI: "/img/logos/unknown-token.png",
        verified: false,
        chainId,
      };

      const imported = localStorage.getItem("importedTokens");
      const importedTokens: Token[] = imported ? JSON.parse(imported) : [];
      const alreadyImported = importedTokens.find((t: Token) => t.address.toLowerCase() === address.toLowerCase());
      if (!alreadyImported) {
        importedTokens.push(newToken);
        localStorage.setItem("importedTokens", JSON.stringify(importedTokens));
      }

      setTokens((prev) => [...prev, newToken]);
      toast({ title: "Token imported", description: `${symbol} has been added to your token list` });
      return newToken;
    } catch (error: any) {
      console.error("Token import error:", error);
      let errorMessage = "Failed to import token";
      if (error.message.includes("timeout")) errorMessage = "Request timed out. Please check the address and try again.";
      else if (error.message.includes("Invalid")) errorMessage = error.message;
      else errorMessage = "Unable to fetch token data. Please verify the address is correct.";
      toast({ title: "Import failed", description: errorMessage, variant: "destructive" });
      return null;
    }
  };

  // Set default tokens
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

  // Check if either token needs wrapping (native -> ERC20)
  const needsWrapA = tokenA ? isNativeToken(tokenA.address) : false;
  const needsWrapB = tokenB ? isNativeToken(tokenB.address) : false;
  const needsWrapping = needsWrapA || needsWrapB;

  // Check if pool exists and get current price
  useEffect(() => {
    const checkPool = async () => {
      if (!tokenA || !tokenB || !contracts || !window.ethereum || !chainId) return;

      setIsCheckingPool(true);
      try {
        const provider = new BrowserProvider(window.ethereum);
        const factory = new Contract(contracts.v3.factory, V3_FACTORY_ABI, provider);

        const tokenAForPool = { ...tokenA, address: getERC20Address(tokenA, chainId) };
        const tokenBForPool = { ...tokenB, address: getERC20Address(tokenB, chainId) };
        const [token0, token1] = sortTokens(tokenAForPool, tokenBForPool);
        const poolAddress = await factory.getPool(token0.address, token1.address, selectedFee);

        if (poolAddress && poolAddress !== "0x0000000000000000000000000000000000000000") {
          setPoolExists(true);

          const pool = new Contract(poolAddress, V3_POOL_ABI, provider);
          const slot0 = await pool.slot0();
          const sqrtPriceX96 = slot0[0];
          const tick = Number(slot0[1]);

          setCurrentSqrtPriceX96(sqrtPriceX96);
          setCurrentTick(tick);

          const price = sqrtPriceX96ToPrice(sqrtPriceX96, token0.decimals, token1.decimals);
          setCurrentPrice(price);
        } else {
          setPoolExists(false);
          setCurrentPrice(null);
          setCurrentSqrtPriceX96(null);
          setCurrentTick(null);
        }
      } catch (error) {
        console.error("Error checking pool:", error);
        setPoolExists(false);
        setCurrentPrice(null);
      } finally {
        setIsCheckingPool(false);
      }
    };

    checkPool();
  }, [tokenA, tokenB, selectedFee, contracts]);

  // Auto-calculate amountB based on current pool price
  useEffect(() => {
    if (!currentPrice || !amountA || !tokenA || !tokenB || !chainId) return;

    const amountAFloat = parseFloat(amountA);
    if (isNaN(amountAFloat) || amountAFloat <= 0) return;

    try {
      const tokenAForPool = { ...tokenA, address: getERC20Address(tokenA, chainId) };
      const tokenBForPool = { ...tokenB, address: getERC20Address(tokenB, chainId) };
      const [token0] = sortTokens(tokenAForPool, tokenBForPool);
      const isToken0A = tokenAForPool.address.toLowerCase() === token0.address.toLowerCase();

      const calculatedAmountB = isToken0A
        ? amountAFloat * currentPrice
        : amountAFloat / currentPrice;

      setAmountB(calculatedAmountB.toFixed(6));
    } catch (error) {
      console.error("Error calculating amount:", error);
    }
  }, [amountA, currentPrice, tokenA, tokenB, selectedFee, chainId]);

  const handleAddLiquidity = async () => {
    if (!tokenA || !tokenB || !amountA || !amountB || !address || !contracts || !window.ethereum || !chainId) return;

    setIsAdding(true);
    try {
      const provider = new BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();

      const positionManager = new Contract(
        contracts.v3.nonfungiblePositionManager,
        NONFUNGIBLE_POSITION_MANAGER_ABI,
        signer
      );

      const tokenAIsNative = isNativeToken(tokenA.address);
      const tokenBIsNative = isNativeToken(tokenB.address);

      const tokenAERC20 = getERC20Address(tokenA, chainId);
      const tokenBERC20 = getERC20Address(tokenB, chainId);

      const tokenAForPool = { ...tokenA, address: tokenAERC20 };
      const tokenBForPool = { ...tokenB, address: tokenBERC20 };
      const [token0, token1] = sortTokens(tokenAForPool, tokenBForPool);
      const isToken0A = tokenAERC20.toLowerCase() === token0.address.toLowerCase();

      const amount0Desired = parseAmount(isToken0A ? amountA : amountB, token0.decimals);
      const amount1Desired = parseAmount(isToken0A ? amountB : amountA, token1.decimals);

      let nativeAmount = 0n;
      if (tokenAIsNative) {
        nativeAmount = parseAmount(amountA, tokenA.decimals);
      } else if (tokenBIsNative) {
        nativeAmount = parseAmount(amountB, tokenB.decimals);
      }

      const factory = new Contract(contracts.v3.factory, V3_FACTORY_ABI, provider);
      const poolAddress = await factory.getPool(token0.address, token1.address, selectedFee);
      const poolExistsOnChain = poolAddress && poolAddress !== "0x0000000000000000000000000000000000000000";

      if (!poolExistsOnChain) {
        const price = getPriceFromAmounts(amount0Desired, amount1Desired, token0.decimals, token1.decimals);
        const sqrtPriceX96 = priceToSqrtPriceX96(price, token0.decimals, token1.decimals);

        toast({ title: "Creating V3 pool...", description: "Initializing new pool with current price" });

        if (nativeAmount > 0n) {
          const createData = positionManager.interface.encodeFunctionData("createAndInitializePoolIfNecessary", [
            token0.address, token1.address, selectedFee, sqrtPriceX96,
          ]);
          const refundData = positionManager.interface.encodeFunctionData("refundETH", []);
          const tx = await positionManager.multicall([createData, refundData], { value: nativeAmount });
          await tx.wait();
        } else {
          const createTx = await positionManager.createAndInitializePoolIfNecessary(
            token0.address, token1.address, selectedFee, sqrtPriceX96
          );
          await createTx.wait();
        }
      }

      const { tickLower, tickUpper } = getFullRangeTicks(selectedFee);

      toast({ title: "Approving tokens...", description: "Please approve token spending" });

      if (!tokenAIsNative || !isToken0A) {
        const token0Contract = new Contract(token0.address, ERC20_ABI, signer);
        const allowance0 = await token0Contract.allowance(address, contracts.v3.nonfungiblePositionManager);
        if (allowance0 < amount0Desired) {
          const approveTx = await token0Contract.approve(contracts.v3.nonfungiblePositionManager, amount0Desired);
          await approveTx.wait();
        }
      }

      if (!tokenBIsNative || isToken0A) {
        const token1Contract = new Contract(token1.address, ERC20_ABI, signer);
        const allowance1 = await token1Contract.allowance(address, contracts.v3.nonfungiblePositionManager);
        if (allowance1 < amount1Desired) {
          const approveTx = await token1Contract.approve(contracts.v3.nonfungiblePositionManager, amount1Desired);
          await approveTx.wait();
        }
      }

      const amount0Min = (amount0Desired * 98n) / 100n;
      const amount1Min = (amount1Desired * 98n) / 100n;
      const deadline = Math.floor(Date.now() / 1000) + 1200;

      toast({ title: "Adding liquidity...", description: "Creating V3 position" });

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
        const mintData = positionManager.interface.encodeFunctionData("mint", [params]);
        const refundData = positionManager.interface.encodeFunctionData("refundETH", []);
        const gasEstimate = await positionManager.multicall.estimateGas([mintData, refundData], { value: nativeAmount });
        const gasLimit = (gasEstimate * 150n) / 100n;
        const tx = await positionManager.multicall([mintData, refundData], { value: nativeAmount, gasLimit });
        receipt = await tx.wait();
      } else {
        const gasEstimate = await positionManager.mint.estimateGas(params);
        const gasLimit = (gasEstimate * 150n) / 100n;
        const tx = await positionManager.mint(params, { gasLimit });
        receipt = await tx.wait();
      }

      setAmountA("");
      setAmountB("");

      toast({
        title: "Liquidity added!",
        description: (
          <div className="flex items-center gap-2">
            <span>Successfully added V3 liquidity (Basic Mode - Safe Range)</span>
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

  // Derive human-readable label for the "Add" button based on health state
  const addButtonLabel = () => {
    if (isAdding) return "Adding Liquidity...";
    if (poolHealth?.severity === "error") return "Fix Pool Issues Before Adding";
    return "Add V3 Liquidity (Safe Mode)";
  };

  return (
    <div className="space-y-4">
      {/* Info Banner */}
      <div className="flex items-start gap-3 p-4 bg-blue-500/10 border border-blue-500/20 rounded-lg">
        <Shield className="h-5 w-5 text-blue-400 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <h3 className="font-semibold text-blue-400 text-sm">Basic Mode - Safe & Simple</h3>
          <p className="text-xs text-slate-300">
            Your liquidity will be placed in a wide price range for safety. This mode is recommended for beginners and
            provides protection against impermanent loss.
          </p>
        </div>
      </div>

      {/* Token Selection */}
      <Card className="bg-slate-900 border-slate-700">
        <CardContent className="p-6 space-y-4">
          {/* Token A */}
          <div className="space-y-2">
            <Label className="text-sm text-slate-400">Token A</Label>
            <div className="flex gap-2">
              <Input
                type="number"
                placeholder="0.00"
                value={amountA}
                onChange={(e) => setAmountA(e.target.value)}
                className="flex-1 bg-slate-800 border-slate-600"
              />
              <Button
                variant="outline"
                onClick={() => setShowTokenASelector(true)}
                className="min-w-[120px]"
              >
                {tokenA ? (
                  <div className="flex items-center gap-2">
                    {tokenA.logoURI && <img src={tokenA.logoURI} alt={tokenA.symbol} className="w-5 h-5 rounded-full" />}
                    <span>{tokenA.symbol}</span>
                  </div>
                ) : (
                  <span>Select Token</span>
                )}
              </Button>
            </div>
          </div>

          {/* Token B */}
          <div className="space-y-2">
            <Label className="text-sm text-slate-400">Token B</Label>
            <div className="flex gap-2">
              <Input
                type="number"
                placeholder="0.00"
                value={amountB}
                onChange={(e) => setAmountB(e.target.value)}
                className="flex-1 bg-slate-800 border-slate-600"
                disabled={poolExists && !!currentPrice}
              />
              <Button
                variant="outline"
                onClick={() => setShowTokenBSelector(true)}
                className="min-w-[120px]"
              >
                {tokenB ? (
                  <div className="flex items-center gap-2">
                    {tokenB.logoURI && <img src={tokenB.logoURI} alt={tokenB.symbol} className="w-5 h-5 rounded-full" />}
                    <span>{tokenB.symbol}</span>
                  </div>
                ) : (
                  <span>Select Token</span>
                )}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Fee Tier Selection */}
      <Card className="bg-slate-900 border-slate-700">
        <CardContent className="p-6 space-y-3">
          <Label className="text-sm text-slate-400">Fee Tier</Label>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {feeOptions.map((option) => (
              <Button
                key={option.value}
                variant={selectedFee === option.value ? "default" : "outline"}
                onClick={() => setSelectedFee(option.value)}
                className="flex flex-col h-auto py-3"
              >
                <span className="font-semibold">{option.label}</span>
                <span className="text-xs opacity-70">{option.description}</span>
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ── Pool Health Checker ──────────────────────────────────────────────── */}
      {/* Replaces the old plain "Pool Status" info box.                          */}
      {/* Shows green OK, yellow warnings, or red errors with one-click fixes.    */}
      {tokenA && tokenB && (
        <PoolHealthChecker
          tokenA={tokenA}
          tokenB={tokenB}
          fee={selectedFee}
          chainId={chainId}
          expectedPriceRatio={expectedPriceRatio}
          onHealthChange={setPoolHealth}
        />
      )}

      {/* Wrapping Notice */}
      {needsWrapping && tokenA && tokenB && (
        <div className="flex items-start gap-3 p-4 bg-green-500/10 border border-green-500/20 rounded-lg">
          <Shield className="h-5 w-5 text-green-400 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <h3 className="font-semibold text-green-400 text-sm">Efficient Native Token Handling</h3>
            <p className="text-xs text-slate-300">
              Your native {needsWrapA ? tokenA.symbol : tokenB.symbol} will be automatically wrapped in a single
              transaction. No manual wrapping needed - saves gas and time!
            </p>
          </div>
        </div>
      )}

      {/* Add Liquidity Button */}
      {isConnected ? (
        <Button
          onClick={handleAddLiquidity}
          disabled={
            !tokenA ||
            !tokenB ||
            !amountA ||
            !amountB ||
            isAdding ||
            parseFloat(amountA) <= 0 ||
            parseFloat(amountB) <= 0 ||
            // Block adding when pool has a critical error (broken price, uninitialized, etc.)
            // Yellow "warn" states still allow adding so the user can proceed with caution.
            poolHealth?.severity === "error"
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

      {/* Token Selectors */}
      <TokenSelector
        open={showTokenASelector}
        onClose={() => setShowTokenASelector(false)}
        onSelect={(token) => {
          setTokenA(token);
          setShowTokenASelector(false);
        }}
        tokens={tokens}
        onImport={handleImportToken}
      />

      <TokenSelector
        open={showTokenBSelector}
        onClose={() => setShowTokenBSelector(false)}
        onSelect={(token) => {
          setTokenB(token);
          setShowTokenBSelector(false);
        }}
        tokens={tokens}
        onImport={handleImportToken}
      />
    </div>
  );
}
