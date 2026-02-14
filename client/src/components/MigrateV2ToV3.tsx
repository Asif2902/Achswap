import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useAccount, useChainId } from "wagmi";
import { useToast } from "@/hooks/use-toast";
import type { Token } from "@shared/schema";
import { Contract, BrowserProvider } from "ethers";
import { getTokensByChainId } from "@/data/tokens";
import { formatAmount } from "@/lib/decimal-utils";
import { getContractsForChain } from "@/lib/contracts";
import { V3_MIGRATOR_ABI, NONFUNGIBLE_POSITION_MANAGER_ABI, V3_FEE_TIERS, FEE_TIER_LABELS } from "@/lib/abis/v3";
import { ArrowRight, AlertCircle, ExternalLink, RefreshCw } from "lucide-react";

const V2_PAIR_ABI = [
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function balanceOf(address owner) external view returns (uint256)",
  "function totalSupply() external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
];

const V2_FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) external view returns (address pair)",
  "function allPairsLength() external view returns (uint256)",
  "function allPairs(uint256) external view returns (address pair)",
];

const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

interface V2Position {
  pairAddress: string;
  token0: Token;
  token1: Token;
  lpBalance: bigint;
  reserve0: bigint;
  reserve1: bigint;
  sharePercent: number;
}

export function MigrateV2ToV3() {
  const [positions, setPositions] = useState<V2Position[]>([]);
  const [selectedPosition, setSelectedPosition] = useState<V2Position | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isMigrating, setIsMigrating] = useState(false);
  const [selectedFee, setSelectedFee] = useState<number>(V3_FEE_TIERS.MEDIUM);
  const [percentToMigrate, setPercentToMigrate] = useState(100);

  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { toast } = useToast();

  const contracts = chainId ? getContractsForChain(chainId) : null;
  const tokens = chainId ? getTokensByChainId(chainId) : [];

  const feeOptions = [
    { value: V3_FEE_TIERS.LOW, label: "0.05%" },
    { value: V3_FEE_TIERS.MEDIUM, label: "0.3%" },
    { value: V3_FEE_TIERS.HIGH, label: "1%" },
  ];

  // Load user's V2 positions
  const loadPositions = async () => {
    if (!address || !contracts || !window.ethereum) return;

    setIsLoading(true);
    try {
      const provider = new BrowserProvider(window.ethereum);
      const factory = new Contract(contracts.v2.factory, V2_FACTORY_ABI, provider);

      const pairsLength = await factory.allPairsLength();
      const userPositions: V2Position[] = [];

      // Check all pairs (limited to first 50 for performance)
      const maxPairs = Math.min(Number(pairsLength), 50);

      for (let i = 0; i < maxPairs; i++) {
        try {
          const pairAddress = await factory.allPairs(i);
          const pairContract = new Contract(pairAddress, V2_PAIR_ABI, provider);

          const lpBalance = await pairContract.balanceOf(address);

          if (lpBalance > 0n) {
            const token0Address = await pairContract.token0();
            const token1Address = await pairContract.token1();
            const reserves = await pairContract.getReserves();
            const totalSupply = await pairContract.totalSupply();

            // Get token details
            const token0Contract = new Contract(token0Address, ERC20_ABI, provider);
            const token1Contract = new Contract(token1Address, ERC20_ABI, provider);

            const [name0, symbol0, decimals0] = await Promise.all([
              token0Contract.name(),
              token0Contract.symbol(),
              token0Contract.decimals(),
            ]);

            const [name1, symbol1, decimals1] = await Promise.all([
              token1Contract.name(),
              token1Contract.symbol(),
              token1Contract.decimals(),
            ]);

            const token0: Token = {
              address: token0Address,
              name: name0,
              symbol: symbol0,
              decimals: Number(decimals0),
              logoURI: tokens.find(t => t.address.toLowerCase() === token0Address.toLowerCase())?.logoURI || "/img/logos/unknown-token.png",
              verified: false,
              chainId: chainId!,
            };

            const token1: Token = {
              address: token1Address,
              name: name1,
              symbol: symbol1,
              decimals: Number(decimals1),
              logoURI: tokens.find(t => t.address.toLowerCase() === token1Address.toLowerCase())?.logoURI || "/img/logos/unknown-token.png",
              verified: false,
              chainId: chainId!,
            };

            const sharePercent = Number((lpBalance * 10000n) / totalSupply) / 100;

            userPositions.push({
              pairAddress,
              token0,
              token1,
              lpBalance,
              reserve0: reserves[0],
              reserve1: reserves[1],
              sharePercent,
            });
          }
        } catch (error) {
          // Skip pairs that error out
          continue;
        }
      }

      setPositions(userPositions);

      if (userPositions.length === 0) {
        toast({
          title: "No V2 positions found",
          description: "You don't have any V2 liquidity positions to migrate",
        });
      }
    } catch (error) {
      console.error("Error loading positions:", error);
      toast({
        title: "Failed to load positions",
        description: "Could not fetch your V2 liquidity positions",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isConnected && address) {
      loadPositions();
    }
  }, [isConnected, address, chainId]);

  const handleMigrate = async () => {
    if (!selectedPosition || !address || !contracts || !window.ethereum) return;

    setIsMigrating(true);
    try {
      const provider = new BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();

      const migrator = new Contract(contracts.v3.migrator, V3_MIGRATOR_ABI, signer);
      const npm = new Contract(contracts.v3.nonfungiblePositionManager, NONFUNGIBLE_POSITION_MANAGER_ABI, signer);
      const pairContract = new Contract(selectedPosition.pairAddress, V2_PAIR_ABI, signer);

      // Calculate liquidity to migrate
      const liquidityToMigrate = (selectedPosition.lpBalance * BigInt(percentToMigrate)) / 100n;

      // Sort tokens by address (required by V3 contracts)
      const { sortTokens, priceToSqrtPriceX96, getPriceFromAmounts, getFullRangeTicks } = await import("@/lib/v3-utils");
      const [sortedToken0, sortedToken1] = sortTokens(selectedPosition.token0, selectedPosition.token1);
      const isOriginalOrder = sortedToken0.address.toLowerCase() === selectedPosition.token0.address.toLowerCase();

      // Use sorted reserves for calculations
      const reserve0Sorted = isOriginalOrder ? selectedPosition.reserve0 : selectedPosition.reserve1;
      const reserve1Sorted = isOriginalOrder ? selectedPosition.reserve1 : selectedPosition.reserve0;

      // Calculate expected amounts (with 5% slippage for safety)
      const amount0 = (reserve0Sorted * liquidityToMigrate) / selectedPosition.lpBalance;
      const amount1 = (reserve1Sorted * liquidityToMigrate) / selectedPosition.lpBalance;
      const amount0Min = (amount0 * 95n) / 100n;
      const amount1Min = (amount1 * 95n) / 100n;

      // CRITICAL: Create V3 pool first if it doesn't exist
      // Calculate price from V2 reserves using sorted tokens
      const price = getPriceFromAmounts(
        reserve0Sorted,
        reserve1Sorted,
        sortedToken0.decimals,
        sortedToken1.decimals
      );
      const sqrtPriceX96 = priceToSqrtPriceX96(price, sortedToken0.decimals, sortedToken1.decimals);

      toast({
        title: "Step 1/3: Ensuring V3 pool exists...",
        description: "Creating or verifying V3 pool for migration",
      });

      // Use NonfungiblePositionManager to create pool (not migrator)
      try {
        const createTx = await npm.createAndInitializePoolIfNecessary(
          sortedToken0.address,
          sortedToken1.address,
          selectedFee,
          sqrtPriceX96
        );
        await createTx.wait();
        console.log("V3 pool created/verified successfully");
      } catch (poolError: any) {
        // Pool may already exist - check if it's a real error
        const errorMsg = poolError.message || "";
        if (errorMsg.includes("already initialized") || errorMsg.includes("Pool already exists")) {
          console.log("Pool already exists, continuing with migration");
        } else {
          console.warn("Pool creation warning:", errorMsg);
          // Try to continue - pool might already exist
        }
      }

      // Approve LP tokens with max allowance to avoid re-approval
      toast({
        title: "Step 2/3: Approving LP tokens...",
        description: "Please approve LP token spending in your wallet",
      });

      const allowance = await pairContract.allowance(address, contracts.v3.migrator);
      if (allowance < liquidityToMigrate) {
        // Approve max to avoid future re-approvals
        const maxApproval = 2n ** 256n - 1n;
        const approveTx = await pairContract.approve(contracts.v3.migrator, maxApproval);
        await approveTx.wait();
        console.log("LP token approval confirmed");
      }

      // Use full range for safety
      const { tickLower, tickUpper } = getFullRangeTicks(selectedFee);

      toast({
        title: "Step 3/3: Migrating liquidity...",
        description: "Removing V2 liquidity and adding to V3. Please confirm in your wallet.",
      });

      const params = {
        pair: selectedPosition.pairAddress,
        liquidityToMigrate,
        percentageToMigrate: percentToMigrate,
        token0: sortedToken0.address,
        token1: sortedToken1.address,
        fee: selectedFee,
        tickLower,
        tickUpper,
        amount0Min,
        amount1Min,
        recipient: address,
        deadline: Math.floor(Date.now() / 1000) + 1200,
        refundAsETH: false,
      };

      console.log("Migration params:", {
        ...params,
        liquidityToMigrate: params.liquidityToMigrate.toString(),
        amount0Min: params.amount0Min.toString(),
        amount1Min: params.amount1Min.toString(),
      });

      let tx;
      try {
        const gasEstimate = await migrator.migrate.estimateGas(params);
        const gasLimit = (gasEstimate * 150n) / 100n;
        tx = await migrator.migrate(params, { gasLimit });
      } catch (estimateError: any) {
        console.warn("Gas estimation failed, trying with manual gas limit:", estimateError.message);
        // If gas estimation fails, try with a generous manual gas limit
        tx = await migrator.migrate(params, { gasLimit: 1_000_000n });
      }

      const receipt = await tx.wait();

      if (receipt.status === 0) {
        throw new Error("Transaction reverted on-chain");
      }

      setSelectedPosition(null);
      await loadPositions(); // Reload positions

      toast({
        title: "Migration successful!",
        description: (
          <div className="flex items-center gap-2">
            <span>Successfully migrated from V2 to V3</span>
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
      console.error("Migration error:", error);

      let errorMessage = "Transaction failed";
      if (error.reason) {
        errorMessage = error.reason;
      } else if (error.message) {
        // Parse common revert reasons
        if (error.message.includes("insufficient")) {
          errorMessage = "Insufficient balance or allowance";
        } else if (error.message.includes("slippage") || error.message.includes("Price slippage")) {
          errorMessage = "Price slippage too high. Try increasing slippage tolerance.";
        } else if (error.message.includes("user rejected") || error.message.includes("denied")) {
          errorMessage = "Transaction rejected by user";
        } else if (error.message.includes("TRANSFER_FROM_FAILED")) {
          errorMessage = "LP token transfer failed. Please check approval.";
        } else {
          errorMessage = error.message.substring(0, 200);
        }
      }

      toast({
        title: "Migration failed",
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setIsMigrating(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Info Banner */}
      <div className="flex items-start gap-3 p-4 bg-blue-500/10 border border-blue-500/20 rounded-lg">
        <RefreshCw className="h-5 w-5 text-blue-400 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <h3 className="font-semibold text-blue-400 text-sm">Migrate V2 → V3</h3>
          <p className="text-xs text-slate-300">
            Move your V2 liquidity to V3 for better capital efficiency and concentrated liquidity
          </p>
        </div>
      </div>

      {/* V2 Positions List */}
      {isLoading ? (
        <Card className="bg-slate-900 border-slate-700">
          <CardContent className="p-6 text-center text-slate-400">
            Loading your V2 positions...
          </CardContent>
        </Card>
      ) : positions.length === 0 ? (
        <Card className="bg-slate-900 border-slate-700">
          <CardContent className="p-6 text-center space-y-3">
            <AlertCircle className="h-12 w-12 text-slate-600 mx-auto" />
            <p className="text-slate-400">No V2 liquidity positions found</p>
            <Button
              variant="outline"
              size="sm"
              onClick={loadPositions}
              className="mt-2"
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {positions.map((position, index) => (
            <Card
              key={index}
              className={`bg-slate-900 border-slate-700 cursor-pointer transition-all ${
                selectedPosition?.pairAddress === position.pairAddress
                  ? "ring-2 ring-blue-500"
                  : "hover:border-slate-600"
              }`}
              onClick={() => setSelectedPosition(position)}
            >
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex items-center">
                      <img
                        src={position.token0.logoURI}
                        alt={position.token0.symbol}
                        className="w-8 h-8 rounded-full"
                      />
                      <img
                        src={position.token1.logoURI}
                        alt={position.token1.symbol}
                        className="w-8 h-8 rounded-full -ml-2"
                      />
                    </div>
                    <div>
                      <div className="font-semibold text-white">
                        {position.token0.symbol} / {position.token1.symbol}
                      </div>
                      <div className="text-xs text-slate-400">
                        {formatAmount(position.reserve0, position.token0.decimals)} {position.token0.symbol} +{" "}
                        {formatAmount(position.reserve1, position.token1.decimals)} {position.token1.symbol}
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-medium text-slate-300">
                      {position.sharePercent.toFixed(4)}%
                    </div>
                    <div className="text-xs text-slate-500">Pool Share</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Migration Settings */}
      {selectedPosition && (
        <>
          <Card className="bg-slate-900 border-slate-700">
            <CardContent className="p-6 space-y-4">
              <Label className="text-sm text-slate-400">Select V3 Fee Tier</Label>
              <div className="flex gap-2">
                {feeOptions.map((option) => (
                  <Button
                    key={option.value}
                    variant={selectedFee === option.value ? "default" : "outline"}
                    onClick={() => setSelectedFee(option.value)}
                    className="flex-1"
                  >
                    {option.label}
                  </Button>
                ))}
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-sm text-slate-400">Amount to Migrate</Label>
                  <span className="text-sm text-slate-300">{percentToMigrate}%</span>
                </div>
                <input
                  type="range"
                  min="1"
                  max="100"
                  value={percentToMigrate}
                  onChange={(e) => setPercentToMigrate(parseInt(e.target.value))}
                  className="w-full"
                />
                <div className="flex justify-between text-xs text-slate-500">
                  <span>1%</span>
                  <span>100%</span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Migration Preview */}
          <Card className="bg-slate-900 border-slate-700">
            <CardContent className="p-6 space-y-4">
              <h3 className="font-semibold text-white">Migration Preview</h3>

              <div className="flex items-center justify-between py-3 border-b border-slate-700">
                <span className="text-slate-400 text-sm">From V2</span>
                <span className="text-white font-medium">
                  {selectedPosition.token0.symbol} / {selectedPosition.token1.symbol}
                </span>
              </div>

              <div className="flex items-center justify-center py-2">
                <ArrowRight className="h-6 w-6 text-blue-400" />
              </div>

              <div className="flex items-center justify-between py-3 border-t border-slate-700">
                <span className="text-slate-400 text-sm">To V3</span>
                <span className="text-white font-medium">
                  {FEE_TIER_LABELS[selectedFee as keyof typeof FEE_TIER_LABELS]} Fee Tier
                </span>
              </div>

              <div className="p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
                <p className="text-xs text-yellow-400">
                  <strong>Note:</strong> Migration will use full price range for safety. You can adjust the range later.
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Migrate Button */}
          {isConnected ? (
            <Button
              onClick={handleMigrate}
              disabled={isMigrating}
              className="w-full h-12 text-base font-semibold"
            >
              {isMigrating ? "Migrating..." : "Migrate to V3"}
            </Button>
          ) : (
            <Button disabled className="w-full h-12">
              Connect Wallet
            </Button>
          )}
        </>
      )}
    </div>
  );
}
