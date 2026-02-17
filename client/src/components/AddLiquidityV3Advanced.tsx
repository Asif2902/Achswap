import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TokenSelector } from "@/components/TokenSelector";
import { useAccount, useChainId } from "wagmi";
import { useToast } from "@/hooks/use-toast";
import type { Token } from "@shared/schema";
import { Contract, BrowserProvider } from "ethers";
import { getTokensByChainId, isNativeToken, getWrappedAddress } from "@/data/tokens";
import { formatAmount, parseAmount } from "@/lib/decimal-utils";
import { getContractsForChain } from "@/lib/contracts";
import { NONFUNGIBLE_POSITION_MANAGER_ABI, V3_FACTORY_ABI, V3_POOL_ABI, V3_FEE_TIERS, FEE_TIER_LABELS } from "@/lib/abis/v3";
import { priceToSqrtPriceX96, sqrtPriceX96ToPrice, priceToTick, tickToPrice, getNearestUsableTick, getTickSpacing, sortTokens, isPositionInRange, getFullRangeTicks } from "@/lib/v3-utils";
import { AlertTriangle, Zap, ExternalLink, TrendingUp, TrendingDown, Info, Calculator, Settings, BarChart3, Shield } from "lucide-react";
import { PriceRangeChart } from "./PriceRangeChart";

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
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

export function AddLiquidityV3Advanced() {
  const [tokenA, setTokenA] = useState<Token | null>(null);
  const [tokenB, setTokenB] = useState<Token | null>(null);
  const [amountA, setAmountA] = useState("");
  const [amountB, setAmountB] = useState("");
  const [showTokenASelector, setShowTokenASelector] = useState(false);
  const [showTokenBSelector, setShowTokenBSelector] = useState(false);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [selectedFee, setSelectedFee] = useState<number>(V3_FEE_TIERS.MEDIUM);
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [minTick, setMinTick] = useState("");
  const [maxTick, setMaxTick] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [poolExists, setPoolExists] = useState(false);
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [currentTick, setCurrentTick] = useState<number | null>(null);
  const [poolLiquidity, setPoolLiquidity] = useState<bigint>(0n);
  const [slippage, setSlippage] = useState("2");
  const [useTickMode, setUseTickMode] = useState(false);
  const [balanceA, setBalanceA] = useState<bigint | null>(null);
  const [balanceB, setBalanceB] = useState<bigint | null>(null);

  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { toast } = useToast();

  const contracts = chainId ? getContractsForChain(chainId) : null;

  const feeOptions = [
    { value: V3_FEE_TIERS.LOWEST, label: "0.01%", description: "Very stable pairs (stablecoins)" },
    { value: V3_FEE_TIERS.LOW, label: "0.05%", description: "Stable pairs" },
    { value: V3_FEE_TIERS.MEDIUM, label: "0.3%", description: "Most pairs (recommended)" },
    { value: V3_FEE_TIERS.HIGH, label: "1%", description: "Exotic/volatile pairs" },
    { value: V3_FEE_TIERS.ULTRA_HIGH, label: "10%", description: "Very exotic pairs" },
  ];

  // Load tokens
  useEffect(() => {
    if (!chainId) return;
    const chainTokens = getTokensByChainId(chainId);
    
    // Load imported tokens from localStorage
    const imported = localStorage.getItem('importedTokens');
    const importedTokens: Token[] = imported ? JSON.parse(imported) : [];
    const chainImportedTokens = importedTokens.filter(t => t.chainId === chainId);
    
    setTokens([...chainTokens, ...chainImportedTokens]);
  }, [chainId]);

  const handleImportToken = async (address: string): Promise<Token | null> => {
    try {
      if (!address || address.length !== 42 || !address.startsWith('0x')) {
        throw new Error("Invalid token address format");
      }

      const exists = tokens.find(t => t.address.toLowerCase() === address.toLowerCase());
      if (exists) {
        toast({
          title: "Token already added",
          description: `${exists.symbol} is already in your token list`,
        });
        return exists;
      }

      const rpcUrl = 'https://rpc.testnet.arc.network';
      const provider = new BrowserProvider({
        request: async ({ method, params }: any) => {
          const response = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method,
              params,
            }),
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
        Promise.all([
          contract.name(),
          contract.symbol(),
          contract.decimals(),
        ]),
        timeout
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

      const imported = localStorage.getItem('importedTokens');
      const importedTokens: Token[] = imported ? JSON.parse(imported) : [];

      const alreadyImported = importedTokens.find((t: Token) => t.address.toLowerCase() === address.toLowerCase());
      if (!alreadyImported) {
        importedTokens.push(newToken);
        localStorage.setItem('importedTokens', JSON.stringify(importedTokens));
      }

      setTokens(prev => [...prev, newToken]);

      toast({
        title: "Token imported",
        description: `${symbol} has been added to your token list`,
      });

      return newToken;
    } catch (error: any) {
      console.error('Token import error:', error);
      let errorMessage = "Failed to import token";

      if (error.message.includes("timeout")) {
        errorMessage = "Request timed out. Please check the address and try again.";
      } else if (error.message.includes("Invalid")) {
        errorMessage = error.message;
      } else {
        errorMessage = "Unable to fetch token data. Please verify the address is correct.";
      }

      toast({
        title: "Import failed",
        description: errorMessage,
        variant: "destructive",
      });
      return null;
    }
  };

  // Set default tokens
  useEffect(() => {
    if (tokens.length === 0) return;
    if (!tokenA) {
      const usdc = tokens.find(t => t.symbol === 'USDC');
      if (usdc) setTokenA(usdc);
    }
    if (!tokenB) {
      const achs = tokens.find(t => t.symbol === 'ACHS');
      if (achs) setTokenB(achs);
    }
  }, [tokens, tokenA, tokenB]);

  // Load balances
  useEffect(() => {
    const loadBalances = async () => {
      if (!address || !window.ethereum || !tokenA || !tokenB) return;
      
      try {
        const provider = new BrowserProvider(window.ethereum);
        
        // Load token A balance
        const tokenAERC20 = getERC20Address(tokenA, chainId!);
        if (isNativeToken(tokenA.address)) {
          const bal = await provider.getBalance(address);
          setBalanceA(bal);
        } else {
          const contract = new Contract(tokenAERC20, ERC20_ABI, provider);
          const bal = await contract.balanceOf(address);
          setBalanceA(bal);
        }
        
        // Load token B balance
        const tokenBERC20 = getERC20Address(tokenB, chainId!);
        if (isNativeToken(tokenB.address)) {
          const bal = await provider.getBalance(address);
          setBalanceB(bal);
        } else {
          const contract = new Contract(tokenBERC20, ERC20_ABI, provider);
          const bal = await contract.balanceOf(address);
          setBalanceB(bal);
        }
      } catch (error) {
        console.error("Error loading balances:", error);
      }
    };
    
    loadBalances();
  }, [address, tokenA, tokenB, chainId]);

  // Check if either token needs wrapping
  const needsWrapA = tokenA ? isNativeToken(tokenA.address) : false;
  const needsWrapB = tokenB ? isNativeToken(tokenB.address) : false;
  const needsWrapping = needsWrapA || needsWrapB;

  // Check pool and get current price
  useEffect(() => {
    const checkPool = async () => {
      if (!tokenA || !tokenB || !contracts || !window.ethereum || !chainId) return;

      try {
        const provider = new BrowserProvider(window.ethereum);
        const factory = new Contract(contracts.v3.factory, V3_FACTORY_ABI, provider);

        // Use ERC20 addresses for pool lookup
        const tokenAForPool = { ...tokenA, address: getERC20Address(tokenA, chainId) };
        const tokenBForPool = { ...tokenB, address: getERC20Address(tokenB, chainId) };
        const [token0, token1] = sortTokens(tokenAForPool, tokenBForPool);
        const poolAddress = await factory.getPool(token0.address, token1.address, selectedFee);

        if (poolAddress && poolAddress !== "0x0000000000000000000000000000000000000000") {
          setPoolExists(true);

          const pool = new Contract(poolAddress, V3_POOL_ABI, provider);
          const slot0 = await pool.slot0();
          const sqrtPriceX96 = slot0[0];
          const tick = slot0[1];
          const liquidity = await pool.liquidity();

          // Use the utility function for consistent price calculation
          const adjustedPrice = sqrtPriceX96ToPrice(sqrtPriceX96, token0.decimals, token1.decimals);

          setCurrentPrice(adjustedPrice);
          setCurrentTick(Number(tick));
          setPoolLiquidity(liquidity);

          // Set default range around current price if not set
          if (!minPrice && !maxPrice) {
            const lowerPrice = (adjustedPrice * 0.8).toFixed(6);
            const upperPrice = (adjustedPrice * 1.2).toFixed(6);
            setMinPrice(lowerPrice);
            setMaxPrice(upperPrice);
            
            // Also set ticks
            const tickSpacing = getTickSpacing(selectedFee);
            const lowerTick = getNearestUsableTick(priceToTick(adjustedPrice * 0.8, token0.decimals, token1.decimals), tickSpacing);
            const upperTick = getNearestUsableTick(priceToTick(adjustedPrice * 1.2, token0.decimals, token1.decimals), tickSpacing);
            setMinTick(lowerTick.toString());
            setMaxTick(upperTick.toString());
          }
        } else {
          setPoolExists(false);
          setCurrentPrice(null);
          setCurrentTick(null);
          setPoolLiquidity(0n);
        }
      } catch (error) {
        console.error("Error checking pool:", error);
        setPoolExists(false);
      }
    };

    checkPool();
  }, [tokenA, tokenB, selectedFee, contracts]);

  // Sync price and tick inputs
  useEffect(() => {
    if (!tokenA || !tokenB || !chainId) return;
    
    const tokenAForPool = { ...tokenA, address: getERC20Address(tokenA, chainId) };
    const tokenBForPool = { ...tokenB, address: getERC20Address(tokenB, chainId) };
    const [token0, token1] = sortTokens(tokenAForPool, tokenBForPool);
    
    if (useTickMode && minTick && maxTick) {
      // Convert ticks to prices
      const minP = tickToPrice(parseInt(minTick), token0.decimals, token1.decimals);
      const maxP = tickToPrice(parseInt(maxTick), token1.decimals, token0.decimals);
      setMinPrice(minP.toFixed(6));
      setMaxPrice(maxP.toFixed(6));
    } else if (!useTickMode && minPrice && maxPrice) {
      // Convert prices to ticks
      const tickSpacing = getTickSpacing(selectedFee);
      const minT = getNearestUsableTick(priceToTick(parseFloat(minPrice), token0.decimals, token1.decimals), tickSpacing);
      const maxT = getNearestUsableTick(priceToTick(parseFloat(maxPrice), token0.decimals, token1.decimals), tickSpacing);
      setMinTick(minT.toString());
      setMaxTick(maxT.toString());
    }
  }, [useTickMode, minTick, maxTick, minPrice, maxPrice, tokenA, tokenB, chainId, selectedFee]);

  // Auto-calculate amountB based on current pool price
  useEffect(() => {
    if (!currentPrice || !amountA || !tokenA || !tokenB || !chainId) return;

    const amountAFloat = parseFloat(amountA);
    if (isNaN(amountAFloat) || amountAFloat <= 0) return;

    try {
      const tokenAForPool = { ...tokenA, address: getERC20Address(tokenA, chainId) };
      const tokenBForPool = { ...tokenB, address: getERC20Address(tokenB, chainId) };
      const [token0, token1] = sortTokens(tokenAForPool, tokenBForPool);
      const isToken0A = tokenAForPool.address.toLowerCase() === token0.address.toLowerCase();

      const calculatedAmountB = isToken0A 
        ? amountAFloat * currentPrice 
        : amountAFloat / currentPrice;
      
      setAmountB(calculatedAmountB.toFixed(6));
    } catch (error) {
      console.error("Error calculating amount:", error);
    }
  }, [amountA, currentPrice, tokenA, tokenB, chainId]);

  // Quick range presets
  const applyRangePreset = (preset: 'full' | 'wide' | 'narrow' | 'current') => {
    if (!currentPrice || !tokenA || !tokenB || !chainId) return;
    
    const tokenAForPool = { ...tokenA, address: getERC20Address(tokenA, chainId) };
    const tokenBForPool = { ...tokenB, address: getERC20Address(tokenB, chainId) };
    const [token0, token1] = sortTokens(tokenAForPool, tokenBForPool);
    const tickSpacing = getTickSpacing(selectedFee);
    
    if (preset === 'full') {
      const { tickLower, tickUpper } = getFullRangeTicks(selectedFee);
      setMinTick(tickLower.toString());
      setMaxTick(tickUpper.toString());
      const minP = tickToPrice(tickLower, token0.decimals, token1.decimals);
      const maxP = tickToPrice(tickUpper, token0.decimals, token1.decimals);
      setMinPrice(minP.toFixed(10));
      setMaxPrice(maxP.toFixed(10));
    } else if (preset === 'wide') {
      const lowerPrice = currentPrice * 0.5;
      const upperPrice = currentPrice * 2;
      setMinPrice(lowerPrice.toFixed(6));
      setMaxPrice(upperPrice.toFixed(6));
      const minT = getNearestUsableTick(priceToTick(lowerPrice, token0.decimals, token1.decimals), tickSpacing);
      const maxT = getNearestUsableTick(priceToTick(upperPrice, token0.decimals, token1.decimals), tickSpacing);
      setMinTick(minT.toString());
      setMaxTick(maxT.toString());
    } else if (preset === 'narrow') {
      const lowerPrice = currentPrice * 0.9;
      const upperPrice = currentPrice * 1.1;
      setMinPrice(lowerPrice.toFixed(6));
      setMaxPrice(upperPrice.toFixed(6));
      const minT = getNearestUsableTick(priceToTick(lowerPrice, token0.decimals, token1.decimals), tickSpacing);
      const maxT = getNearestUsableTick(priceToTick(upperPrice, token0.decimals, token1.decimals), tickSpacing);
      setMinTick(minT.toString());
      setMaxTick(maxT.toString());
    } else if (preset === 'current') {
      // Single-sided at current price
      const tickLower = getNearestUsableTick(currentTick || 0, tickSpacing);
      const tickUpper = tickLower + tickSpacing;
      setMinTick(tickLower.toString());
      setMaxTick(tickUpper.toString());
      const minP = tickToPrice(tickLower, token0.decimals, token1.decimals);
      const maxP = tickToPrice(tickUpper, token0.decimals, token1.decimals);
      setMinPrice(minP.toFixed(6));
      setMaxPrice(maxP.toFixed(6));
    }
  };

  const handleAddLiquidity = async () => {
    if (!tokenA || !tokenB || !amountA || !amountB || !address || !contracts || !window.ethereum || !chainId) return;

    const minPriceFloat = parseFloat(minPrice);
    const maxPriceFloat = parseFloat(maxPrice);

    if (!useTickMode && (minPriceFloat <= 0 || maxPriceFloat <= 0 || minPriceFloat >= maxPriceFloat)) {
      toast({
        title: "Invalid price range",
        description: "Min price must be less than max price and both must be positive",
        variant: "destructive",
      });
      return;
    }

    setIsAdding(true);
    try {
      const provider = new BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();

      const positionManager = new Contract(
        contracts.v3.nonfungiblePositionManager,
        NONFUNGIBLE_POSITION_MANAGER_ABI,
        signer
      );

      // Check which tokens are native
      const tokenAIsNative = isNativeToken(tokenA.address);
      const tokenBIsNative = isNativeToken(tokenB.address);

      // Get ERC20 addresses for V3 (native tokens use their wrapped version)
      const tokenAERC20 = getERC20Address(tokenA, chainId);
      const tokenBERC20 = getERC20Address(tokenB, chainId);

      // Sort tokens using ERC20 addresses
      const tokenAForPool = { ...tokenA, address: tokenAERC20 };
      const tokenBForPool = { ...tokenB, address: tokenBERC20 };
      const [token0, token1] = sortTokens(tokenAForPool, tokenBForPool);
      const isToken0A = tokenAERC20.toLowerCase() === token0.address.toLowerCase();

      const amount0Desired = parseAmount(isToken0A ? amountA : amountB, token0.decimals);
      const amount1Desired = parseAmount(isToken0A ? amountB : amountA, token1.decimals);

      // Determine native token amount for msg.value
      // Position Manager will wrap internally - no need to manually wrap!
      let nativeAmount = 0n;
      if (tokenAIsNative) {
        nativeAmount = parseAmount(amountA, tokenA.decimals);
      } else if (tokenBIsNative) {
        nativeAmount = parseAmount(amountB, tokenB.decimals);
      }

      // Convert prices to ticks
      const tickSpacing = getTickSpacing(selectedFee);
      let tickLower: number;
      let tickUpper: number;
      
      if (useTickMode) {
        tickLower = getNearestUsableTick(parseInt(minTick), tickSpacing);
        tickUpper = getNearestUsableTick(parseInt(maxTick), tickSpacing);
      } else {
        tickLower = getNearestUsableTick(
          priceToTick(minPriceFloat, token0.decimals, token1.decimals),
          tickSpacing
        );
        tickUpper = getNearestUsableTick(
          priceToTick(maxPriceFloat, token0.decimals, token1.decimals),
          tickSpacing
        );
      }

      // Create pool if it doesn't exist
      if (!poolExists) {
        const midPrice = (minPriceFloat + maxPriceFloat) / 2;
        const sqrtPriceX96 = priceToSqrtPriceX96(midPrice, token0.decimals, token1.decimals);

        toast({
          title: "Creating pool...",
          description: "Initializing new V3 pool",
        });

        // Use multicall for pool creation + refund if native token involved
        if (nativeAmount > 0n) {
          const createData = positionManager.interface.encodeFunctionData("createAndInitializePoolIfNecessary", [
            token0.address,
            token1.address,
            selectedFee,
            sqrtPriceX96
          ]);
          const refundData = positionManager.interface.encodeFunctionData("refundETH", []);
          
          const tx = await positionManager.multicall([createData, refundData], { value: nativeAmount });
          await tx.wait();
        } else {
          const createTx = await positionManager.createAndInitializePoolIfNecessary(
            token0.address,
            token1.address,
            selectedFee,
            sqrtPriceX96
          );
          await createTx.wait();
        }
      }

      // Approve tokens - only for non-native tokens
      // Native tokens don't need approval - Position Manager handles wrapping internally
      toast({
        title: "Approving tokens...",
        description: "Please approve token spending",
      });

      // Approve token0 if not native
      if (!tokenAIsNative || !isToken0A) {
        const token0Contract = new Contract(token0.address, ERC20_ABI, signer);
        const allowance0 = await token0Contract.allowance(address, contracts.v3.nonfungiblePositionManager);
        if (allowance0 < amount0Desired) {
          const approveTx = await token0Contract.approve(contracts.v3.nonfungiblePositionManager, amount0Desired);
          await approveTx.wait();
        }
      }

      // Approve token1 if not native
      if (!tokenBIsNative || isToken0A) {
        const token1Contract = new Contract(token1.address, ERC20_ABI, signer);
        const allowance1 = await token1Contract.allowance(address, contracts.v3.nonfungiblePositionManager);
        if (allowance1 < amount1Desired) {
          const approveTx = await token1Contract.approve(contracts.v3.nonfungiblePositionManager, amount1Desired);
          await approveTx.wait();
        }
      }

      // Calculate slippage-protected minimums
      const slippagePercent = parseFloat(slippage) || 2;
      const slippageMultiplier = BigInt(Math.floor((100 - slippagePercent) * 100));
      const amount0Min = (amount0Desired * slippageMultiplier) / 10000n;
      const amount1Min = (amount1Desired * slippageMultiplier) / 10000n;
      const deadline = Math.floor(Date.now() / 1000) + 1200;

      toast({
        title: "Adding liquidity...",
        description: "Creating V3 position with custom range",
      });

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

      // Use multicall for mint + refundETH if native token involved
      // This is the efficient single-transaction approach!
      let receipt;
      if (nativeAmount > 0n) {
        // Encode mint call
        const mintData = positionManager.interface.encodeFunctionData("mint", [params]);
        // Encode refundETH to get back unused native tokens
        const refundData = positionManager.interface.encodeFunctionData("refundETH", []);
        
        // Execute both calls in one transaction with native token value
        const gasEstimate = await positionManager.multicall.estimateGas([mintData, refundData], { value: nativeAmount });
        const gasLimit = (gasEstimate * 150n) / 100n;
        const tx = await positionManager.multicall([mintData, refundData], { value: nativeAmount, gasLimit });
        receipt = await tx.wait();
      } else {
        // No native token - just mint directly
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
            <span>Successfully added V3 liquidity (Advanced Mode)</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2"
              onClick={() => window.open(`${contracts.explorer}${receipt.hash}`, '_blank')}
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

  // Check if position is in range
  const isInRange = currentTick !== null && minTick && maxTick && tokenA && tokenB && chainId
    ? (() => {
        const tickLower = parseInt(minTick);
        const tickUpper = parseInt(maxTick);
        return isPositionInRange(currentTick, tickLower, tickUpper);
      })()
    : null;

  return (
    <div className="space-y-4">
      {/* Warning Banner */}
      <div className="flex items-start gap-3 p-4 bg-orange-500/10 border border-orange-500/20 rounded-lg">
        <AlertTriangle className="h-5 w-5 text-orange-400 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <h3 className="font-semibold text-orange-400 text-sm">Advanced Mode - Full Control</h3>
          <p className="text-xs text-slate-300">
            You have full control over price ranges, ticks, and slippage. Incorrect settings may result in capital inefficiency or losses.
          </p>
        </div>
      </div>

      {/* Token Selection */}
      <Card className="bg-slate-900 border-slate-700">
        <CardContent className="p-6 space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm text-slate-400">Token A</Label>
              {balanceA && tokenA && (
                <span className="text-xs text-slate-500">
                  Balance: {formatAmount(balanceA, tokenA.decimals)}
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <Input
                type="number"
                placeholder="0.00"
                value={amountA}
                onChange={(e) => setAmountA(e.target.value)}
                className="flex-1 bg-slate-800 border-slate-600"
              />
              <Button variant="outline" onClick={() => setShowTokenASelector(true)} className="min-w-[120px]">
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

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm text-slate-400">Token B</Label>
              {balanceB && tokenB && (
                <span className="text-xs text-slate-500">
                  Balance: {formatAmount(balanceB, tokenB.decimals)}
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <Input
                type="number"
                placeholder="0.00"
                value={amountB}
                onChange={(e) => setAmountB(e.target.value)}
                className="flex-1 bg-slate-800 border-slate-600"
              />
              <Button variant="outline" onClick={() => setShowTokenBSelector(true)} className="min-w-[120px]">
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
          <div className="flex items-center gap-2">
            <Label className="text-sm text-slate-400">Fee Tier</Label>
            <Info className="h-4 w-4 text-slate-500" />
          </div>
          <div className="flex gap-2 flex-wrap">
            {feeOptions.map((option) => (
              <Button
                key={option.value}
                variant={selectedFee === option.value ? "default" : "outline"}
                onClick={() => setSelectedFee(option.value)}
                className="flex-1 min-w-[80px]"
                title={option.description}
              >
                {option.label}
              </Button>
            ))}
          </div>
          {poolExists && (
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <BarChart3 className="h-4 w-4" />
              <span>Pool Liquidity: {formatAmount(poolLiquidity, 18)}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Price Range Mode Toggle */}
      <Card className="bg-slate-900 border-slate-700">
        <CardContent className="p-6 space-y-4">
          <div className="flex items-center justify-between">
            <Label className="text-sm text-slate-400">Input Mode</Label>
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
          </div>

          {/* Quick Range presets */}
          {poolExists && currentPrice && (
            <div className="space-y-2">
              <Label className="text-xs text-slate-500">Quick Range Presets</Label>
              <div className="flex gap-2 flex-wrap">
                <Button variant="outline" size="sm" onClick={() => applyRangePreset('full')}>
                  Full Range
                </Button>
                <Button variant="outline" size="sm" onClick={() => applyRangePreset('wide')}>
                  Wide (0.5x - 2x)
                </Button>
                <Button variant="outline" size="sm" onClick={() => applyRangePreset('narrow')}>
                  Narrow (±10%)
                </Button>
                <Button variant="outline" size="sm" onClick={() => applyRangePreset('current')}>
                  At Current
                </Button>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between">
            <Label className="text-sm text-slate-400">Price Range</Label>
            {poolExists && currentPrice && (
              <span className="text-xs text-slate-400">
                Current: {currentPrice.toFixed(6)} ({currentTick})
              </span>
            )}
          </div>

          {!useTickMode ? (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-xs text-slate-500">Min Price ({tokenB?.symbol || 'B'}/{tokenA?.symbol || 'A'})</Label>
                <div className="relative">
                  <Input
                    type="number"
                    placeholder="0.00"
                    value={minPrice}
                    onChange={(e) => setMinPrice(e.target.value)}
                    className="bg-slate-800 border-slate-600"
                  />
                  <TrendingDown className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-xs text-slate-500">Max Price ({tokenB?.symbol || 'B'}/{tokenA?.symbol || 'A'})</Label>
                <div className="relative">
                  <Input
                    type="number"
                    placeholder="0.00"
                    value={maxPrice}
                    onChange={(e) => setMaxPrice(e.target.value)}
                    className="bg-slate-800 border-slate-600"
                  />
                  <TrendingUp className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                </div>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-xs text-slate-500">Tick Lower</Label>
                <Input
                  type="number"
                  placeholder="-887272"
                  value={minTick}
                  onChange={(e) => setMinTick(e.target.value)}
                  className="bg-slate-800 border-slate-600"
                />
              </div>

              <div className="space-y-2">
                <Label className="text-xs text-slate-500">Tick Upper</Label>
                <Input
                  type="number"
                  placeholder="887272"
                  value={maxTick}
                  onChange={(e) => setMaxTick(e.target.value)}
                  className="bg-slate-800 border-slate-600"
                />
              </div>
            </div>
          )}

          {/* Price Range Chart */}
          {tokenA && tokenB && minPrice && maxPrice && parseFloat(minPrice) > 0 && parseFloat(maxPrice) > 0 && (
            <PriceRangeChart
              minPrice={parseFloat(minPrice)}
              maxPrice={parseFloat(maxPrice)}
              currentPrice={currentPrice || undefined}
              token0Symbol={tokenA.symbol}
              token1Symbol={tokenB.symbol}
            />
          )}

          {/* Range Status */}
          {isInRange !== null && poolExists && (
            <div className={`p-3 rounded-lg border ${
              isInRange 
                ? 'bg-green-500/10 border-green-500/20 text-green-400' 
                : 'bg-orange-500/10 border-orange-500/20 text-orange-400'
            }`}>
              <div className="flex items-center gap-2 text-sm font-medium">
                {isInRange ? (
                  <>
                    <Zap className="h-4 w-4" />
                    <span>Position is IN RANGE - Will earn fees</span>
                  </>
                ) : (
                  <>
                    <AlertTriangle className="h-4 w-4" />
                    <span>Position is OUT OF RANGE - Won't earn fees until price returns</span>
                  </>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Slippage Settings */}
      <Card className="bg-slate-900 border-slate-700">
        <CardContent className="p-6 space-y-3">
          <div className="flex items-center gap-2">
            <Settings className="h-4 w-4 text-slate-400" />
            <Label className="text-sm text-slate-400">Slippage Tolerance</Label>
          </div>
          <div className="flex gap-2">
            {['0.5', '1', '2', '5'].map((s) => (
              <Button
                key={s}
                variant={slippage === s ? "default" : "outline"}
                size="sm"
                onClick={() => setSlippage(s)}
              >
                {s}%
              </Button>
            ))}
            <div className="flex items-center gap-1">
              <Input
                type="number"
                value={slippage}
                onChange={(e) => setSlippage(e.target.value)}
                className="w-20 bg-slate-800 border-slate-600"
              />
              <span className="text-sm text-slate-400">%</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Wrapping Notice - Updated for multicall efficiency */}
      {needsWrapping && tokenA && tokenB && (
        <div className="flex items-start gap-3 p-4 bg-green-500/10 border border-green-500/20 rounded-lg">
          <Shield className="h-5 w-5 text-green-400 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <h3 className="font-semibold text-green-400 text-sm">Efficient Native Token Handling</h3>
            <p className="text-xs text-slate-300">
              Your native {needsWrapA ? tokenA.symbol : tokenB.symbol} will be automatically wrapped in a single transaction. 
              No manual wrapping needed - saves gas and time!
            </p>
          </div>
        </div>
      )}

      {/* Add Liquidity Button */}
      {isConnected ? (
        <Button
          onClick={handleAddLiquidity}
          disabled={!tokenA || !tokenB || !amountA || !amountB || !minPrice || !maxPrice || isAdding}
          className="w-full h-12 text-base font-semibold"
        >
          {isAdding ? "Adding Liquidity..." : "Add V3 Liquidity (Advanced Mode)"}
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
