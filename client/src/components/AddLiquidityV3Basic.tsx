import { useState, useEffect } from "react";
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
import { AlertTriangle, Info, Shield, ExternalLink, ArrowDownUp } from "lucide-react";

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

const WRAPPED_TOKEN_ABI = [
  "function deposit() payable",
  "function withdraw(uint256 amount) returns (bool)",
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

  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { toast } = useToast();

  const contracts = chainId ? getContractsForChain(chainId) : null;

  // Fee tier options
  const feeOptions = [
    { value: V3_FEE_TIERS.LOWEST, label: "0.01%", description: "Best for very stable pairs" },
    { value: V3_FEE_TIERS.LOW, label: "0.05%", description: "Best for stable pairs" },
    { value: V3_FEE_TIERS.MEDIUM, label: "0.3%", description: "Best for most pairs" },
    { value: V3_FEE_TIERS.HIGH, label: "1%", description: "Best for exotic pairs" },
    { value: V3_FEE_TIERS.ULTRA_HIGH, label: "10%", description: "Best for very exotic pairs" },
  ];

  // Load tokens
  useEffect(() => {
    if (!chainId) return;
    const chainTokens = getTokensByChainId(chainId);
    setTokens(chainTokens);
  }, [chainId]);

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

        // Use ERC20 addresses for pool lookup (native tokens use their wrapped version)
        const tokenAForPool = { ...tokenA, address: getERC20Address(tokenA, chainId) };
        const tokenBForPool = { ...tokenB, address: getERC20Address(tokenB, chainId) };
        const [token0, token1] = sortTokens(tokenAForPool, tokenBForPool);
        const poolAddress = await factory.getPool(token0.address, token1.address, selectedFee);

        if (poolAddress && poolAddress !== "0x0000000000000000000000000000000000000000") {
          setPoolExists(true);

          // Get current price from pool
          const pool = new Contract(poolAddress, V3_POOL_ABI, provider);
          const slot0 = await pool.slot0();
          const sqrtPriceX96 = slot0[0];
          const tick = Number(slot0[1]);

          // Store raw values for calculations
          setCurrentSqrtPriceX96(sqrtPriceX96);
          setCurrentTick(tick);

          // Calculate human-readable price
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

  // Auto-calculate amountB based on current price and tick range
  useEffect(() => {
    if (!currentSqrtPriceX96 || !amountA || !tokenA || !tokenB || !currentTick || !chainId) return;

    const amountAFloat = parseFloat(amountA);
    if (isNaN(amountAFloat) || amountAFloat <= 0) return;

    try {
      // Use ERC20 addresses for sorting (V3 uses wrapped tokens)
      const tokenAForPool = { ...tokenA, address: getERC20Address(tokenA, chainId) };
      const tokenBForPool = { ...tokenB, address: getERC20Address(tokenB, chainId) };
      const [token0, token1] = sortTokens(tokenAForPool, tokenBForPool);
      const isToken0A = tokenAForPool.address.toLowerCase() === token0.address.toLowerCase();

      // Get tick range for full range position
      const { tickLower, tickUpper } = getFullRangeTicks(selectedFee);

      // Parse amount to bigint
      const inputAmount = parseAmount(amountA, isToken0A ? token0.decimals : token1.decimals);

      // Calculate proper amounts based on V3 liquidity math
      const { amount0, amount1 } = calculateAmountsForLiquidity(
        inputAmount,
        isToken0A,
        currentSqrtPriceX96,
        tickLower,
        tickUpper,
        token0.decimals,
        token1.decimals
      );

      // Format the calculated amount for display
      const calculatedAmountB = isToken0A 
        ? formatAmount(amount1, token1.decimals)
        : formatAmount(amount0, token0.decimals);

      setAmountB(calculatedAmountB);
    } catch (error) {
      console.error("Error calculating amount:", error);
      // Fallback to simple price calculation
      if (currentPrice && chainId) {
        const tokenAForPool = { ...tokenA, address: getERC20Address(tokenA, chainId) };
        const tokenBForPool = { ...tokenB, address: getERC20Address(tokenB, chainId) };
        const [token0] = sortTokens(tokenAForPool, tokenBForPool);
        const isToken0A = tokenAForPool.address.toLowerCase() === token0.address.toLowerCase();
        const calculatedAmountB = isToken0A 
          ? amountAFloat * currentPrice 
          : amountAFloat / currentPrice;
        setAmountB(calculatedAmountB.toFixed(6));
      }
    }
  }, [amountA, currentSqrtPriceX96, currentTick, tokenA, tokenB, selectedFee, currentPrice]);

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

      // CRITICAL: V3 only works with ERC20 tokens - wrap native tokens first
      const tokenAIsNative = isNativeToken(tokenA.address);
      const tokenBIsNative = isNativeToken(tokenB.address);

      // Get ERC20 addresses for V3 (native tokens use their wrapped version)
      const tokenAERC20 = getERC20Address(tokenA, chainId);
      const tokenBERC20 = getERC20Address(tokenB, chainId);

      // Wrap native tokens if needed
      if (tokenAIsNative) {
        const wrappedAddress = getWrappedAddress(chainId, tokenA.address);
        if (!wrappedAddress) throw new Error("No wrapped token found for native token");
        
        toast({
          title: "Wrapping native token...",
          description: `Wrapping ${tokenA.symbol} to w${tokenA.symbol}`,
        });

        const wrappedContract = new Contract(wrappedAddress, WRAPPED_TOKEN_ABI, signer);
        const wrapAmount = parseAmount(amountA, tokenA.decimals);
        const wrapTx = await wrappedContract.deposit({ value: wrapAmount });
        await wrapTx.wait();
      }

      if (tokenBIsNative) {
        const wrappedAddress = getWrappedAddress(chainId, tokenB.address);
        if (!wrappedAddress) throw new Error("No wrapped token found for native token");
        
        toast({
          title: "Wrapping native token...",
          description: `Wrapping ${tokenB.symbol} to w${tokenB.symbol}`,
        });

        const wrappedContract = new Contract(wrappedAddress, WRAPPED_TOKEN_ABI, signer);
        const wrapAmount = parseAmount(amountB, tokenB.decimals);
        const wrapTx = await wrappedContract.deposit({ value: wrapAmount });
        await wrapTx.wait();
      }

      // Sort tokens using ERC20 addresses - CRITICAL: V3 requires token0 < token1 by address
      const tokenAForPool = { ...tokenA, address: tokenAERC20 };
      const tokenBForPool = { ...tokenB, address: tokenBERC20 };
      const [token0, token1] = sortTokens(tokenAForPool, tokenBForPool);
      const isToken0A = tokenAERC20.toLowerCase() === token0.address.toLowerCase();

      const amount0Desired = parseAmount(isToken0A ? amountA : amountB, token0.decimals);
      const amount1Desired = parseAmount(isToken0A ? amountB : amountA, token1.decimals);

      // Calculate price from amounts for pool initialization
      const price = getPriceFromAmounts(amount0Desired, amount1Desired, token0.decimals, token1.decimals);
      const sqrtPriceX96 = priceToSqrtPriceX96(price, token0.decimals, token1.decimals);

      // ALWAYS try to create/initialize pool first - this is safe even if pool exists
      toast({
        title: "Ensuring pool exists...",
        description: "Creating or verifying V3 pool",
      });

      try {
        const createTx = await positionManager.createAndInitializePoolIfNecessary(
          token0.address,
          token1.address,
          selectedFee,
          sqrtPriceX96
        );
        await createTx.wait();
      } catch (poolError: any) {
        // Pool might already exist with different price - that's OK
        console.log("Pool creation note:", poolError.message);
      }

      // Get ticks - use full range for maximum safety in Basic mode
      const { tickLower, tickUpper } = getFullRangeTicks(selectedFee);

      // Approve tokens (using ERC20 addresses)
      toast({
        title: "Approving tokens...",
        description: "Please approve token spending",
      });

      const token0Contract = new Contract(token0.address, ERC20_ABI, signer);
      const token1Contract = new Contract(token1.address, ERC20_ABI, signer);

      const allowance0 = await token0Contract.allowance(address, contracts.v3.nonfungiblePositionManager);
      if (allowance0 < amount0Desired) {
        const approveTx = await token0Contract.approve(contracts.v3.nonfungiblePositionManager, amount0Desired);
        await approveTx.wait();
      }

      const allowance1 = await token1Contract.allowance(address, contracts.v3.nonfungiblePositionManager);
      if (allowance1 < amount1Desired) {
        const approveTx = await token1Contract.approve(contracts.v3.nonfungiblePositionManager, amount1Desired);
        await approveTx.wait();
      }

      // Mint position with 2% slippage
      const amount0Min = (amount0Desired * 98n) / 100n;
      const amount1Min = (amount1Desired * 98n) / 100n;
      const deadline = Math.floor(Date.now() / 1000) + 1200; // 20 minutes

      toast({
        title: "Adding liquidity...",
        description: "Creating V3 position",
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

      const gasEstimate = await positionManager.mint.estimateGas(params);
      const gasLimit = (gasEstimate * 150n) / 100n;
      const tx = await positionManager.mint(params, { gasLimit });
      const receipt = await tx.wait();

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

  return (
    <div className="space-y-4">
      {/* Info Banner */}
      <div className="flex items-start gap-3 p-4 bg-blue-500/10 border border-blue-500/20 rounded-lg">
        <Shield className="h-5 w-5 text-blue-400 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <h3 className="font-semibold text-blue-400 text-sm">Basic Mode - Safe & Simple</h3>
          <p className="text-xs text-slate-300">
            Your liquidity will be placed in a wide price range for safety. This mode is recommended for beginners and provides protection against impermanent loss.
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

      {/* Pool Status */}
      {tokenA && tokenB && (
        <div className="flex items-start gap-3 p-4 bg-slate-800/50 border border-slate-700 rounded-lg">
          <Info className="h-5 w-5 text-slate-400 shrink-0 mt-0.5" />
          <div className="space-y-1 text-sm">
            {isCheckingPool ? (
              <p className="text-slate-400">Checking pool...</p>
            ) : poolExists ? (
              <>
                <p className="text-green-400 font-medium">✓ Pool exists</p>
                {currentPrice && (
                  <p className="text-slate-400">
                    Current price: 1 {tokenA.symbol} = {currentPrice.toFixed(6)} {tokenB.symbol}
                  </p>
                )}
                <p className="text-slate-400 text-xs">Your liquidity will be added to existing pool with wide price range</p>
              </>
            ) : (
              <>
                <p className="text-yellow-400 font-medium">⚠ Pool doesn't exist</p>
                <p className="text-slate-400 text-xs">A new pool will be created with your initial price ratio</p>
              </>
            )}
          </div>
        </div>
      )}

      {/* Wrapping Notice */}
      {needsWrapping && tokenA && tokenB && (
        <div className="flex items-start gap-3 p-4 bg-orange-500/10 border border-orange-500/20 rounded-lg">
          <ArrowDownUp className="h-5 w-5 text-orange-400 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <h3 className="font-semibold text-orange-400 text-sm">Auto-Wrapping Required</h3>
            <p className="text-xs text-slate-300">
              V3 pools require ERC20 tokens. Your native {needsWrapA ? tokenA.symbol : tokenB.symbol} will be automatically wrapped to {needsWrapA ? `w${tokenA.symbol}` : `w${tokenB.symbol}`} before adding liquidity.
            </p>
          </div>
        </div>
      )}

      {/* Add Liquidity Button */}
      {isConnected ? (
        <Button
          onClick={handleAddLiquidity}
          disabled={!tokenA || !tokenB || !amountA || !amountB || isAdding || parseFloat(amountA) <= 0 || parseFloat(amountB) <= 0}
          className="w-full h-12 text-base font-semibold"
        >
          {isAdding ? "Adding Liquidity..." : "Add V3 Liquidity (Safe Mode)"}
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
        selectedToken={tokenA}
        otherToken={tokenB}
      />

      <TokenSelector
        open={showTokenBSelector}
        onClose={() => setShowTokenBSelector(false)}
        onSelect={(token) => {
          setTokenB(token);
          setShowTokenBSelector(false);
        }}
        tokens={tokens}
        selectedToken={tokenB}
        otherToken={tokenA}
      />
    </div>
  );
}
