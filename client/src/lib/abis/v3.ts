// Uniswap V3 Contract ABIs

export const QUOTER_V2_ABI = [
  "function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  "function quoteExactInput(bytes path, uint256 amountIn) external returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
];

export const SWAP_ROUTER_V3_ABI = [
  "function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)",
  "function exactInput(tuple(bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params) external payable returns (uint256 amountOut)",
  "function multicall(bytes[] data) external payable returns (bytes[] results)",
  "function refundETH() external payable",
  "function unwrapWETH9(uint256 amountMinimum, address recipient) external payable",
];

export const NONFUNGIBLE_POSITION_MANAGER_ABI = [
  "function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function mint(tuple(address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) external payable returns (address pool)",
  "function increaseLiquidity(tuple(uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) external payable returns (uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function decreaseLiquidity(tuple(uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) external payable returns (uint256 amount0, uint256 amount1)",
  "function collect(tuple(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) external payable returns (uint256 amount0, uint256 amount1)",
  "function burn(uint256 tokenId) external payable",
  "function balanceOf(address owner) external view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256)",
  "function approve(address to, uint256 tokenId) external",
  "function ownerOf(uint256 tokenId) external view returns (address)",
];

export const V3_FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)",
  "function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool)",
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
];

export const V3_POOL_ABI = [
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "function fee() external view returns (uint24)",
  "function tickSpacing() external view returns (int24)",
  "function liquidity() external view returns (uint128)",
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function observe(uint32[] secondsAgos) external view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)",
  "function initialize(uint160 sqrtPriceX96) external",
];

export const V3_MIGRATOR_ABI = [
  "function migrate(tuple(address pair, uint256 liquidityToMigrate, uint8 percentageToMigrate, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline, bool refundAsETH) params) external",
  "function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) external payable returns (address pool)",
];

export const TICK_LENS_ABI = [
  "function getPopulatedTicksInWord(address pool, int16 tickBitmapIndex) external view returns (tuple(int24 tick, int128 liquidityNet, uint128 liquidityGross)[] populatedTicks)",
];

// Common V3 Fee Tiers
export const V3_FEE_TIERS = {
  LOWEST: 100,    // 0.01%
  LOW: 500,       // 0.05%
  MEDIUM: 3000,   // 0.3%
  HIGH: 10000,    // 1%
  ULTRA_HIGH: 100000, // 10% - for exotic pairs
} as const;

export const FEE_TIER_LABELS = {
  [V3_FEE_TIERS.LOWEST]: "0.01%",
  [V3_FEE_TIERS.LOW]: "0.05%",
  [V3_FEE_TIERS.MEDIUM]: "0.3%",
  [V3_FEE_TIERS.HIGH]: "1%",
  [V3_FEE_TIERS.ULTRA_HIGH]: "10%",
} as const;

export type FeeTier = typeof V3_FEE_TIERS[keyof typeof V3_FEE_TIERS];
