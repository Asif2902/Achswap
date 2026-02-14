import { Contract, BrowserProvider } from "ethers";
import { Token } from "@shared/schema";
import { parseAmount } from "./decimal-utils";
import { QUOTER_V2_ABI, V3_FEE_TIERS } from "./abis/v3";
import type { RouteHop } from "@/components/PathVisualizer";

// V2 Router ABI
const V2_ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)",
];

// Native token address (zero address)
const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Check if token is native (zero address)
 */
function isNativeToken(address: string): boolean {
  return address === NATIVE_TOKEN_ADDRESS;
}

/**
 * Get ERC20 address for a token (wraps native to wrapped)
 */
function getERC20Address(tokenAddress: string, wrappedTokenAddress: string): string {
  return isNativeToken(tokenAddress) ? wrappedTokenAddress : tokenAddress;
}

export interface QuoteResult {
  protocol: "V2" | "V3";
  outputAmount: bigint;
  route: RouteHop[];
  priceImpact: number;
  gasEstimate?: bigint;
}

export interface SmartRoutingResult {
  bestQuote: QuoteResult;
  v2Quote?: QuoteResult;
  v3Quote?: QuoteResult;
}

/**
 * Get V2 quote for a swap
 */
export async function getV2Quote(
  provider: BrowserProvider,
  routerAddress: string,
  fromToken: Token,
  toToken: Token,
  amountIn: bigint,
  wrappedTokenAddress: string
): Promise<QuoteResult | null> {
  try {
    const router = new Contract(routerAddress, V2_ROUTER_ABI, provider);
    
    // Build path
    const path = buildV2Path(fromToken, toToken, wrappedTokenAddress);
    
    // Get quote
    const amounts = await router.getAmountsOut(amountIn, path);
    const outputAmount = amounts[amounts.length - 1];
    
    // Calculate price impact
    const priceImpact = await calculateV2PriceImpact(
      router,
      amountIn,
      outputAmount,
      path
    );
    
    // Build route hops for visualization
    const route: RouteHop[] = [];
    for (let i = 0; i < path.length - 1; i++) {
      route.push({
        tokenIn: i === 0 ? fromToken : getTokenForAddress(path[i], fromToken, toToken, wrappedTokenAddress),
        tokenOut: i === path.length - 2 ? toToken : getTokenForAddress(path[i + 1], fromToken, toToken, wrappedTokenAddress),
        protocol: "V2",
      });
    }
    
    return {
      protocol: "V2",
      outputAmount,
      route,
      priceImpact,
    };
  } catch (error) {
    console.error("V2 quote failed:", error);
    return null;
  }
}

/**
 * Get V3 quote for a swap (single-hop and multi-hop)
 * V3 only works with ERC20 tokens, so native tokens must use wrapped address
 */
export async function getV3Quote(
  provider: BrowserProvider,
  quoterAddress: string,
  fromToken: Token,
  toToken: Token,
  amountIn: bigint,
  wrappedTokenAddress?: string
): Promise<QuoteResult | null> {
  try {
    // Check if quoter contract exists
    const code = await provider.getCode(quoterAddress);
    if (!code || code === "0x" || code === "0x0") {
      console.warn("V3 Quoter contract not found at", quoterAddress);
      return null;
    }

    if (!wrappedTokenAddress) {
      console.warn("Wrapped token address required for V3 quotes");
      return null;
    }

    const quoter = new Contract(quoterAddress, QUOTER_V2_ABI, provider);
    
    const feeTiers = [
      V3_FEE_TIERS.LOW,
      V3_FEE_TIERS.MEDIUM,
      V3_FEE_TIERS.HIGH,
    ];
    
    let bestQuote: QuoteResult | null = null;
    
    // V3 only works with ERC20 tokens - use wrapped address for native tokens
    const fromTokenERC20 = getERC20Address(fromToken.address, wrappedTokenAddress);
    const toTokenERC20 = getERC20Address(toToken.address, wrappedTokenAddress);
    
    // Try single-hop routes for all fee tiers
    for (const fee of feeTiers) {
      try {
        const params = {
          tokenIn: fromTokenERC20,
          tokenOut: toTokenERC20,
          amountIn: amountIn,
          fee: fee,
          sqrtPriceLimitX96: 0,
        };
        
        const result = await quoter.quoteExactInputSingle.staticCall(params);
        const outputAmount = result[0];
        const gasEstimate = result[3];
        
        if (!bestQuote || outputAmount > bestQuote.outputAmount) {
          const priceImpact = await calculateV3PriceImpact(
            quoter,
            fromTokenERC20,
            toTokenERC20,
            amountIn,
            outputAmount,
            fee
          );
          
          bestQuote = {
            protocol: "V3",
            outputAmount,
            route: [{
              tokenIn: fromToken, // Keep original token for display
              tokenOut: toToken, // Keep original token for display
              protocol: "V3",
              fee,
            }],
            priceImpact,
            gasEstimate,
          };
        }
      } catch (error) {
        // Pool doesn't exist for this fee tier or other error
        continue;
      }
    }
    
    // Try multi-hop routes if needed (through wrapped token)
    // Only if both tokens are not the wrapped token itself
    if (wrappedTokenAddress.toLowerCase() !== fromTokenERC20.toLowerCase() && 
        wrappedTokenAddress.toLowerCase() !== toTokenERC20.toLowerCase()) {
      for (const fee1 of feeTiers) {
        for (const fee2 of feeTiers) {
          try {
            const { encodePath } = await import("./v3-utils");
            const path = encodePath(
              [fromTokenERC20, wrappedTokenAddress, toTokenERC20],
              [fee1, fee2]
            );
            
            const result = await quoter.quoteExactInput.staticCall(path, amountIn);
            const outputAmount = result[0];
            const gasEstimate = result[3];
            
            if (!bestQuote || outputAmount > bestQuote.outputAmount) {
              const priceImpact = 0;
              
              bestQuote = {
                protocol: "V3",
                outputAmount,
                route: [
                  {
                    tokenIn: fromToken,
                    tokenOut: { 
                      address: wrappedTokenAddress, 
                      symbol: "wUSDC", 
                      name: "Wrapped USDC", 
                      decimals: 18,
                      logoURI: "/img/logos/wusdc.png",
                      verified: true,
                      chainId: fromToken.chainId
                    } as Token,
                    protocol: "V3",
                    fee: fee1,
                  },
                  {
                    tokenIn: { 
                      address: wrappedTokenAddress, 
                      symbol: "wUSDC", 
                      name: "Wrapped USDC", 
                      decimals: 18,
                      logoURI: "/img/logos/wusdc.png",
                      verified: true,
                      chainId: fromToken.chainId
                    } as Token,
                    tokenOut: toToken,
                    protocol: "V3",
                    fee: fee2,
                  },
                ],
                priceImpact,
                gasEstimate,
              };
            }
          } catch (error) {
            continue;
          }
        }
      }
    }
    
    return bestQuote;
  } catch (error) {
    console.error("V3 quote failed:", error);
    return null;
  }
}

/**
 * Get best quote from V2 and V3
 */
export async function getSmartRouteQuote(
  provider: BrowserProvider,
  v2RouterAddress: string,
  v3QuoterAddress: string,
  fromToken: Token,
  toToken: Token,
  amountIn: bigint,
  wrappedTokenAddress: string,
  v2Enabled: boolean,
  v3Enabled: boolean
): Promise<SmartRoutingResult | null> {
  try {
    const quotes = await Promise.allSettled([
      v2Enabled ? getV2Quote(provider, v2RouterAddress, fromToken, toToken, amountIn, wrappedTokenAddress) : Promise.resolve(null),
      v3Enabled ? getV3Quote(provider, v3QuoterAddress, fromToken, toToken, amountIn, wrappedTokenAddress) : Promise.resolve(null),
    ]);
    
    const v2Quote = quotes[0].status === "fulfilled" ? quotes[0].value : null;
    const v3Quote = quotes[1].status === "fulfilled" ? quotes[1].value : null;
    
    // Choose best quote
    let bestQuote: QuoteResult | null = null;
    
    if (v2Quote && v3Quote) {
      bestQuote = v2Quote.outputAmount > v3Quote.outputAmount ? v2Quote : v3Quote;
    } else if (v2Quote) {
      bestQuote = v2Quote;
    } else if (v3Quote) {
      bestQuote = v3Quote;
    }
    
    if (!bestQuote) {
      return null;
    }
    
    return {
      bestQuote,
      v2Quote: v2Quote || undefined,
      v3Quote: v3Quote || undefined,
    };
  } catch (error) {
    console.error("Smart routing failed:", error);
    return null;
  }
}

/**
 * Build V2 path (with multi-hop through wrapped token if needed)
 */
function buildV2Path(
  fromToken: Token,
  toToken: Token,
  wrappedTokenAddress: string
): string[] {
  const isFromNative = fromToken.address === "0x0000000000000000000000000000000000000000";
  const isToNative = toToken.address === "0x0000000000000000000000000000000000000000";
  
  const fromAddress = isFromNative ? wrappedTokenAddress : fromToken.address;
  const toAddress = isToNative ? wrappedTokenAddress : toToken.address;
  
  // If one is wrapped token, use direct path
  if (fromAddress === wrappedTokenAddress || toAddress === wrappedTokenAddress) {
    return [fromAddress, toAddress];
  }
  
  // Otherwise, route through wrapped token
  return [fromAddress, wrappedTokenAddress, toAddress];
}

/**
 * Calculate V2 price impact using midpoint method
 */
async function calculateV2PriceImpact(
  router: Contract,
  amountIn: bigint,
  outputAmount: bigint,
  path: string[]
): Promise<number> {
  try {
    const halfAmountBigInt = amountIn / 2n;
    
    if (halfAmountBigInt > 0n) {
      const halfAmountQuotes = await router.getAmountsOut(halfAmountBigInt, path);
      const halfAmountOutput = halfAmountQuotes[halfAmountQuotes.length - 1];
      
      const expectedOutput = halfAmountOutput * 2n;
      
      if (expectedOutput > 0n && outputAmount > 0n) {
        const impactBasisPoints = expectedOutput > outputAmount
          ? ((expectedOutput - outputAmount) * 10000n) / expectedOutput
          : ((outputAmount - expectedOutput) * 10000n) / expectedOutput;
        
        return Math.max(0, Math.abs(Number(impactBasisPoints) / 100));
      }
    }
    
    return 0;
  } catch (error) {
    console.error("V2 price impact calculation failed:", error);
    return 0;
  }
}

/**
 * Calculate V3 price impact
 */
async function calculateV3PriceImpact(
  quoter: Contract,
  tokenInAddress: string,
  tokenOutAddress: string,
  amountIn: bigint,
  outputAmount: bigint,
  fee: number
): Promise<number> {
  try {
    const halfAmountBigInt = amountIn / 2n;
    
    if (halfAmountBigInt > 0n) {
      const params = {
        tokenIn: tokenInAddress,
        tokenOut: tokenOutAddress,
        amountIn: halfAmountBigInt,
        fee: fee,
        sqrtPriceLimitX96: 0,
      };
      
      const result = await quoter.quoteExactInputSingle.staticCall(params);
      const halfAmountOutput = result[0];
      
      const expectedOutput = halfAmountOutput * 2n;
      
      if (expectedOutput > 0n && outputAmount > 0n) {
        const impactBasisPoints = expectedOutput > outputAmount
          ? ((expectedOutput - outputAmount) * 10000n) / expectedOutput
          : ((outputAmount - expectedOutput) * 10000n) / expectedOutput;
        
        return Math.max(0, Math.abs(Number(impactBasisPoints) / 100));
      }
    }
    
    return 0;
  } catch (error) {
    console.error("V3 price impact calculation failed:", error);
    return 0;
  }
}

/**
 * Sort tokens by address (required for V3)
 */
function sortTokensByAddress(tokenA: Token, tokenB: Token): [Token, Token] {
  const addressA = tokenA.address.toLowerCase();
  const addressB = tokenB.address.toLowerCase();
  return addressA < addressB ? [tokenA, tokenB] : [tokenB, tokenA];
}

/**
 * Helper to get token object for an address in the path
 */
function getTokenForAddress(
  address: string,
  fromToken: Token,
  toToken: Token,
  wrappedTokenAddress: string
): Token {
  if (address.toLowerCase() === fromToken.address.toLowerCase()) return fromToken;
  if (address.toLowerCase() === toToken.address.toLowerCase()) return toToken;
  
  // Return wrapped token placeholder
  return {
    address: wrappedTokenAddress,
    symbol: "wUSDC",
    name: "Wrapped USDC",
    decimals: 18,
    logoURI: "/img/logos/wusdc.png",
    verified: true,
    chainId: fromToken.chainId,
  };
}
