import { sqrtPriceX96ToPrice, priceToSqrtPriceX96 } from "./v3-utils";

const Q96 = 2n ** 96n;

/**
 * Calculate the amount of token1 needed given amount0 and price range
 * Based on Uniswap V3 liquidity math
 */
export function getAmount1ForAmount0(
  amount0: bigint,
  sqrtPriceX96: bigint,
  sqrtPriceLowerX96: bigint,
  sqrtPriceUpperX96: bigint
): bigint {
  if (sqrtPriceX96 <= sqrtPriceLowerX96) {
    // Price is below range, only token0 needed
    return 0n;
  }
  
  if (sqrtPriceX96 >= sqrtPriceUpperX96) {
    // Price is above range, calculate based on full range
    const liquidity = (amount0 * sqrtPriceUpperX96 * sqrtPriceLowerX96) / 
                      ((sqrtPriceUpperX96 - sqrtPriceLowerX96) * Q96);
    return (liquidity * (sqrtPriceUpperX96 - sqrtPriceLowerX96)) / Q96;
  }
  
  // Price is in range
  const liquidity = (amount0 * sqrtPriceX96 * sqrtPriceLowerX96) / 
                    ((sqrtPriceX96 - sqrtPriceLowerX96) * Q96);
  return (liquidity * (sqrtPriceUpperX96 - sqrtPriceX96)) / Q96;
}

/**
 * Calculate the amount of token0 needed given amount1 and price range
 */
export function getAmount0ForAmount1(
  amount1: bigint,
  sqrtPriceX96: bigint,
  sqrtPriceLowerX96: bigint,
  sqrtPriceUpperX96: bigint
): bigint {
  if (sqrtPriceX96 >= sqrtPriceUpperX96) {
    // Price is above range, only token1 needed
    return 0n;
  }
  
  if (sqrtPriceX96 <= sqrtPriceLowerX96) {
    // Price is below range, calculate based on full range
    const liquidity = (amount1 * Q96) / (sqrtPriceUpperX96 - sqrtPriceLowerX96);
    return (liquidity * Q96 * (sqrtPriceUpperX96 - sqrtPriceLowerX96)) / 
           (sqrtPriceUpperX96 * sqrtPriceLowerX96);
  }
  
  // Price is in range
  const liquidity = (amount1 * Q96) / (sqrtPriceUpperX96 - sqrtPriceX96);
  return (liquidity * Q96 * (sqrtPriceX96 - sqrtPriceLowerX96)) / 
         (sqrtPriceX96 * sqrtPriceLowerX96);
}

/**
 * Calculate both amounts needed for a position given one amount
 * This ensures proper ratio based on current pool price and tick range
 */
export function calculateAmountsForLiquidity(
  inputAmount: bigint,
  isToken0: boolean,
  currentSqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  token0Decimals: number,
  token1Decimals: number
): { amount0: bigint; amount1: bigint } {
  // Calculate sqrt prices for tick bounds
  const sqrtPriceLowerX96 = BigInt(Math.floor(Math.sqrt(1.0001 ** tickLower) * Number(Q96)));
  const sqrtPriceUpperX96 = BigInt(Math.floor(Math.sqrt(1.0001 ** tickUpper) * Number(Q96)));
  
  if (isToken0) {
    const amount1 = getAmount1ForAmount0(
      inputAmount,
      currentSqrtPriceX96,
      sqrtPriceLowerX96,
      sqrtPriceUpperX96
    );
    return { amount0: inputAmount, amount1 };
  } else {
    const amount0 = getAmount0ForAmount1(
      inputAmount,
      currentSqrtPriceX96,
      sqrtPriceLowerX96,
      sqrtPriceUpperX96
    );
    return { amount0, amount1: inputAmount };
  }
}

/**
 * Calculate liquidity from amounts
 */
export function getLiquidityForAmounts(
  sqrtPriceX96: bigint,
  sqrtPriceLowerX96: bigint,
  sqrtPriceUpperX96: bigint,
  amount0: bigint,
  amount1: bigint
): bigint {
  if (sqrtPriceX96 <= sqrtPriceLowerX96) {
    // Price below range, use amount0
    return (amount0 * Q96 * sqrtPriceUpperX96 * sqrtPriceLowerX96) / 
           ((sqrtPriceUpperX96 - sqrtPriceLowerX96) * Q96);
  }
  
  if (sqrtPriceX96 >= sqrtPriceUpperX96) {
    // Price above range, use amount1
    return (amount1 * Q96) / (sqrtPriceUpperX96 - sqrtPriceLowerX96);
  }
  
  // Price in range, use both amounts
  const liquidity0 = (amount0 * Q96 * sqrtPriceX96 * sqrtPriceLowerX96) / 
                     ((sqrtPriceX96 - sqrtPriceLowerX96) * Q96);
  const liquidity1 = (amount1 * Q96) / (sqrtPriceUpperX96 - sqrtPriceX96);
  
  // Return the smaller liquidity (limiting factor)
  return liquidity0 < liquidity1 ? liquidity0 : liquidity1;
}

/**
 * Convert V3 liquidity to actual token amounts
 * Uses Uniswap V3's formula to calculate token amounts from liquidity
 * 
 * @param liquidity - The raw liquidity value from V3 position
 * @param currentSqrtPriceX96 - Current pool sqrt price
 * @param tickLower - Lower tick of the position
 * @param tickUpper - Upper tick of the position
 * @returns The actual token amounts (amount0, amount1)
 */
export function getTokensFromLiquidity(
  liquidity: bigint,
  currentSqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number
): { amount0: bigint; amount1: bigint } {
  // Calculate sqrt prices for tick bounds
  const sqrtPriceLowerX96 = BigInt(Math.floor(Math.sqrt(1.0001 ** tickLower) * Number(Q96)));
  const sqrtPriceUpperX96 = BigInt(Math.floor(Math.sqrt(1.0001 ** tickUpper) * Number(Q96)));
  
  let amount0: bigint;
  let amount1: bigint;
  
  if (currentSqrtPriceX96 <= sqrtPriceLowerX96) {
    // Price is below range - all token0
    // amount0 = liquidity * (sqrtPriceUpperX96 - sqrtPriceLowerX96) * Q96 / (sqrtPriceLowerX96 * sqrtPriceUpperX96)
    amount0 = (liquidity * (sqrtPriceUpperX96 - sqrtPriceLowerX96) * Q96) / 
              (sqrtPriceLowerX96 * sqrtPriceUpperX96);
    amount1 = 0n;
  } else if (currentSqrtPriceX96 >= sqrtPriceUpperX96) {
    // Price is above range - all token1
    // amount1 = liquidity * (sqrtPriceUpperX96 - sqrtPriceLowerX96) / Q96
    amount0 = 0n;
    amount1 = (liquidity * (sqrtPriceUpperX96 - sqrtPriceLowerX96)) / Q96;
  } else {
    // Price is in range - both tokens
    // amount0 = liquidity * (sqrtPriceUpperX96 - currentSqrtPriceX96) / (currentSqrtPriceX96 * sqrtPriceUpperX96)
    // amount1 = liquidity * (currentSqrtPriceX96 - sqrtPriceLowerX96) / Q96
    amount0 = (liquidity * (sqrtPriceUpperX96 - currentSqrtPriceX96)) / 
              (currentSqrtPriceX96 * sqrtPriceUpperX96);
    amount1 = (liquidity * (currentSqrtPriceX96 - sqrtPriceLowerX96)) / Q96;
  }
  
  return { amount0, amount1 };
}

/**
 * Simple helper to calculate amount1 from amount0 based on current price
 * For UI display purposes
 */
export function calculateAmount1FromAmount0(
  amount0: number,
  currentPrice: number,
  token0Decimals: number,
  token1Decimals: number
): number {
  // currentPrice is token1/token0
  return amount0 * currentPrice;
}

/**
 * Simple helper to calculate amount0 from amount1 based on current price
 * For UI display purposes
 */
export function calculateAmount0FromAmount1(
  amount1: number,
  currentPrice: number,
  token0Decimals: number,
  token1Decimals: number
): number {
  // currentPrice is token1/token0
  return amount1 / currentPrice;
}
