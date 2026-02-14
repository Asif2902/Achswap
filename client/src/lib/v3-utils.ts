import { Token } from "@shared/schema";

// Constants from Uniswap V3
const Q96 = 2n ** 96n;
const Q192 = Q96 * Q96;
const MIN_TICK = -887272;
const MAX_TICK = 887272;
const MIN_SQRT_RATIO = 4295128739n;
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

/**
 * Convert price to sqrtPriceX96
 * Price is token1/token0 in human-readable format
 */
export function priceToSqrtPriceX96(price: number, token0Decimals: number, token1Decimals: number): bigint {
  // Adjust price for decimals: divide by 10^(token0Decimals - token1Decimals)
  // This converts from human-readable price to raw price
  const decimalAdjustment = 10 ** (token0Decimals - token1Decimals);
  const adjustedPrice = price / decimalAdjustment;
  
  // Calculate sqrt(price) * 2^96
  const sqrtPrice = Math.sqrt(adjustedPrice);
  const sqrtPriceX96 = BigInt(Math.floor(sqrtPrice * Number(Q96)));
  
  // Ensure within valid range
  if (sqrtPriceX96 < MIN_SQRT_RATIO) return MIN_SQRT_RATIO;
  if (sqrtPriceX96 > MAX_SQRT_RATIO) return MAX_SQRT_RATIO;
  
  return sqrtPriceX96;
}

/**
 * Convert sqrtPriceX96 to human-readable price
 * Returns price as token1/token0 (how many token1 per token0)
 */
export function sqrtPriceX96ToPrice(sqrtPriceX96: bigint, token0Decimals: number, token1Decimals: number): number {
  const price = (Number(sqrtPriceX96) / Number(Q96)) ** 2;
  // Adjust for decimals: multiply by 10^(token0Decimals - token1Decimals)
  // This converts from raw price to human-readable price
  const decimalAdjustment = 10 ** (token0Decimals - token1Decimals);
  const adjustedPrice = price * decimalAdjustment;
  return adjustedPrice;
}

/**
 * Calculate price from token amounts
 */
export function getPriceFromAmounts(
  amount0: bigint,
  amount1: bigint,
  token0Decimals: number,
  token1Decimals: number
): number {
  if (amount0 === 0n) return 0;
  
  const amount0Float = Number(amount0) / (10 ** token0Decimals);
  const amount1Float = Number(amount1) / (10 ** token1Decimals);
  
  return amount1Float / amount0Float;
}

/**
 * Get nearest usable tick for a given tick and tick spacing
 */
export function getNearestUsableTick(tick: number, tickSpacing: number): number {
  const rounded = Math.round(tick / tickSpacing) * tickSpacing;
  
  if (rounded < MIN_TICK) return MIN_TICK;
  if (rounded > MAX_TICK) return MAX_TICK;
  
  return rounded;
}

/**
 * Calculate tick from price
 * Price is token1/token0 in human-readable format
 */
export function priceToTick(price: number, token0Decimals: number, token1Decimals: number): number {
  // Convert human-readable price to raw price
  const decimalAdjustment = 10 ** (token0Decimals - token1Decimals);
  const adjustedPrice = price / decimalAdjustment;
  const tick = Math.floor(Math.log(adjustedPrice) / Math.log(1.0001));
  
  if (tick < MIN_TICK) return MIN_TICK;
  if (tick > MAX_TICK) return MAX_TICK;
  
  return tick;
}

/**
 * Calculate price from tick
 * Returns human-readable price (token1/token0)
 */
export function tickToPrice(tick: number, token0Decimals: number, token1Decimals: number): number {
  const rawPrice = 1.0001 ** tick;
  // Convert raw price to human-readable price
  const decimalAdjustment = 10 ** (token0Decimals - token1Decimals);
  return rawPrice * decimalAdjustment;
}

/**
 * Get tick spacing for a fee tier
 */
export function getTickSpacing(fee: number): number {
  switch (fee) {
    case 100: return 1;      // 0.01%
    case 500: return 10;     // 0.05%
    case 3000: return 60;    // 0.3%
    case 10000: return 200;  // 1%
    case 100000: return 200; // 10%
    default: return 60;
  }
}

/**
 * Sort tokens by address (required by Uniswap V3)
 */
export function sortTokens(tokenA: Token, tokenB: Token): [Token, Token] {
  const addressA = tokenA.address.toLowerCase();
  const addressB = tokenB.address.toLowerCase();
  
  return addressA < addressB ? [tokenA, tokenB] : [tokenB, tokenA];
}

/**
 * Get full-range ticks for a fee tier
 */
export function getFullRangeTicks(fee: number): { tickLower: number; tickUpper: number } {
  const tickSpacing = getTickSpacing(fee);
  
  return {
    tickLower: getNearestUsableTick(MIN_TICK, tickSpacing),
    tickUpper: getNearestUsableTick(MAX_TICK, tickSpacing),
  };
}

/**
 * Get safe wide-range ticks around current price (for Basic mode)
 * Returns ticks that cover roughly 10x price range on each side
 */
export function getWideRangeTicks(
  currentPrice: number,
  token0Decimals: number,
  token1Decimals: number,
  fee: number
): { tickLower: number; tickUpper: number } {
  const tickSpacing = getTickSpacing(fee);
  const currentTick = priceToTick(currentPrice, token0Decimals, token1Decimals);
  
  // 10x range on each side (approximately)
  const tickRange = Math.floor(Math.log(10) / Math.log(1.0001)); // ~23028 ticks for 10x
  
  const tickLower = getNearestUsableTick(currentTick - tickRange, tickSpacing);
  const tickUpper = getNearestUsableTick(currentTick + tickRange, tickSpacing);
  
  return { tickLower, tickUpper };
}

/**
 * Check if position is in range
 */
export function isPositionInRange(tick: number, tickLower: number, tickUpper: number): boolean {
  return tick >= tickLower && tick <= tickUpper;
}

/**
 * Encode path for multi-hop swaps
 * Path format: token0 | fee | token1 | fee | token2 | ...
 */
export function encodePath(tokens: string[], fees: number[]): string {
  if (tokens.length !== fees.length + 1) {
    throw new Error("Invalid path: tokens length must be fees length + 1");
  }
  
  let encoded = "0x";
  
  for (let i = 0; i < fees.length; i++) {
    // Add token address (remove 0x prefix)
    encoded += tokens[i].slice(2).toLowerCase();
    
    // Add fee as 3 bytes (24 bits)
    const feeHex = fees[i].toString(16).padStart(6, "0");
    encoded += feeHex;
  }
  
  // Add final token
  encoded += tokens[tokens.length - 1].slice(2).toLowerCase();
  
  return encoded;
}

/**
 * Decode path from bytes
 */
export function decodePath(path: string): { tokens: string[]; fees: number[] } {
  // Remove 0x prefix
  const pathHex = path.startsWith("0x") ? path.slice(2) : path;
  
  const tokens: string[] = [];
  const fees: number[] = [];
  
  let offset = 0;
  
  while (offset < pathHex.length) {
    // Read token (20 bytes = 40 hex chars)
    const token = "0x" + pathHex.slice(offset, offset + 40);
    tokens.push(token);
    offset += 40;
    
    // If there's more data, read fee (3 bytes = 6 hex chars)
    if (offset < pathHex.length) {
      const fee = parseInt(pathHex.slice(offset, offset + 6), 16);
      fees.push(fee);
      offset += 6;
    }
  }
  
  return { tokens, fees };
}

/**
 * Calculate minimum amounts with slippage
 */
export function calculateMinAmountsWithSlippage(
  amount0: bigint,
  amount1: bigint,
  slippagePercent: number
): { amount0Min: bigint; amount1Min: bigint } {
  const slippageFactor = BigInt(Math.floor((100 - slippagePercent) * 100));
  
  return {
    amount0Min: (amount0 * slippageFactor) / 10000n,
    amount1Min: (amount1 * slippageFactor) / 10000n,
  };
}
