import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowDownUp, Settings, AlertTriangle, ExternalLink, HelpCircle, ChevronDown, Bell, ArrowRight } from "lucide-react";
import { TokenSelector } from "@/components/TokenSelector";
import { SwapSettings } from "@/components/SwapSettings";
import { TransactionHistory } from "@/components/TransactionHistory";
import { useAccount, useBalance, useChainId } from "wagmi";
import { useToast } from "@/hooks/use-toast";
import type { Token } from "@shared/schema";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Contract, BrowserProvider, formatUnits, parseUnits } from "ethers";
import { defaultTokens, getTokensByChainId } from "@/data/tokens";
import { formatAmount, parseAmount } from "@/lib/decimal-utils";
import { getContractsForChain } from "@/lib/contracts";

// Chain-specific configuration - add new chains here
const chainConfig: Record<number, {
  nativeSymbol: string;
  wrappedSymbol: string;
  rpcUrl: string;
}> = {
  5042002: {
    nativeSymbol: 'USDC',
    wrappedSymbol: 'wUSDC',
    rpcUrl: 'https://rpc.testnet.arc.network',
  },
};

function getChainConfig(chainId: number) {
  return chainConfig[chainId] || {
    nativeSymbol: 'USDC',
    wrappedSymbol: 'wUSDC',
    rpcUrl: 'https://rpc.testnet.arc.network',
  };
}

// ERC20 ABI for token operations
const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

// Wrapped token contract ABI for deposit/withdraw
const WRAPPED_TOKEN_ABI = [
  "function deposit() payable",
  "function withdraw(uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

export default function Swap() {
  const [fromToken, setFromToken] = useState<Token | null>(null);
  const [toToken, setToToken] = useState<Token | null>(null);
  const [fromAmount, setFromAmount] = useState("");
  const [toAmount, setToAmount] = useState("");
  const [showFromSelector, setShowFromSelector] = useState(false);
  const [showToSelector, setShowToSelector] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [isSwapping, setIsSwapping] = useState(false);
  const [isLoadingQuote, setIsLoadingQuote] = useState(false);
  const [slippage, setSlippage] = useState(0.5);
  const [deadline, setDeadline] = useState(20);
  const [recipientAddress, setRecipientAddress] = useState("");
  const [priceImpact, setPriceImpact] = useState<number | null>(null);
  const [quoteRefreshInterval, setQuoteRefreshInterval] = useState(30);
  const [routingPath, setRoutingPath] = useState<string[]>([]);
  const [showTransactionHistory, setShowTransactionHistory] = useState(false);
  const [isPriceImpactCollapsed, setIsPriceImpactCollapsed] = useState(false);

  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { toast } = useToast();

  // Get chain-specific contracts
  const contracts = chainId ? getContractsForChain(chainId) : null;

  // Function to open transaction in explorer
  const openExplorer = (txHash: string) => {
    if (contracts) {
      window.open(`${contracts.explorer}${txHash}`, '_blank');
    }
  };

  // Load tokens from JSON and localStorage - filter by chain
  useEffect(() => {
    loadTokens();
  }, [chainId]);

  // Set default tokens based on chain
  useEffect(() => {
    if (tokens.length === 0 || !chainId) return;

    const config = getChainConfig(chainId);

    // Set defaults only if not already set or if chain changed
    if (!fromToken || fromToken.chainId !== chainId) {
      const defaultFrom = tokens.find(t => t.symbol === config.nativeSymbol);
      if (defaultFrom) setFromToken(defaultFrom);
    }

    if (!toToken || toToken.chainId !== chainId) {
      // Both chains: default to ACHS
      const achs = tokens.find(t => t.symbol === 'ACHS');
      if (achs) setToToken(achs);
    }
  }, [tokens, fromToken, toToken, chainId]);

  // Fetch quote when fromAmount, fromToken, or toToken changes
  useEffect(() => {
    const fetchQuote = async () => {
      if (!fromToken || !toToken || !fromAmount || parseFloat(fromAmount) <= 0) {
        setToAmount("");
        setPriceImpact(null);
        return;
      }

      // Handle wrap/unwrap - 1:1 ratio (chain-specific)
      const config = getChainConfig(chainId);
      const isWrap = fromToken.symbol === config.nativeSymbol && toToken.symbol === config.wrappedSymbol;
      const isUnwrap = fromToken.symbol === config.wrappedSymbol && toToken.symbol === config.nativeSymbol;

      if (isWrap || isUnwrap) {
        setToAmount(fromAmount);
        setPriceImpact(0);
        return;
      }

      if (!window.ethereum || !contracts) return;

      setIsLoadingQuote(true);
      try {
        const provider = new BrowserProvider(window.ethereum);
        const ROUTER_ABI = [
          "function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)"
        ];

        const router = new Contract(contracts.router, ROUTER_ABI, provider);
        const amountIn = parseAmount(fromAmount, fromToken.decimals);

        // Build path - use wrapped token for liquidity pool routing
        let path: string[] = [];
        const isFromNative = fromToken.address === "0x0000000000000000000000000000000000000000";
        const isToNative = toToken.address === "0x0000000000000000000000000000000000000000";

        // Get wrapped token address for routing (chain-specific)
        const config = getChainConfig(chainId);
        const wrappedSymbol = config.wrappedSymbol;
        const wrappedTokenData = tokens.find(t => t.symbol === wrappedSymbol);
        const wrappedAddress = wrappedTokenData?.address;

        if (!wrappedAddress) {
          throw new Error(`${wrappedSymbol} token not found`);
        }

        // Convert native token addresses to wrapped for pool routing
        const fromTokenAddress = isFromNative ? wrappedAddress : fromToken.address;
        const toTokenAddress = isToNative ? wrappedAddress : toToken.address;

        // Build path based on converted addresses
        if (fromTokenAddress === toTokenAddress) {
          // Same token (shouldn't happen in UI, but handle it)
          path = [fromTokenAddress, toTokenAddress];
        } else if (fromTokenAddress === wrappedAddress || toTokenAddress === wrappedAddress) {
          // Direct path if one token is wrapped
          path = [fromTokenAddress, toTokenAddress];
        } else {
          // Multi-hop through wrapped token
          path = [fromTokenAddress, wrappedAddress, toTokenAddress];
        }

        // Save routing path for visualization
        setRoutingPath(path);

        let amounts;
        try {
          amounts = await router.getAmountsOut(amountIn, path);
        } catch (error) {
          // If multi-hop fails, try direct path
          if (path.length > 2) {
            path = [fromToken.address, toToken.address];
            try {
              amounts = await router.getAmountsOut(amountIn, path);
            } catch {
              throw error;
            }
          } else {
            throw error;
          }
        }

        const outputAmount = formatAmount(amounts[amounts.length - 1], toToken.decimals);
        setToAmount(outputAmount);

        // Calculate price impact using minimum amount comparison
        const fromAmountBigInt = parseAmount(fromAmount, fromToken.decimals);
        const outputAmountBigInt = amounts[amounts.length - 1];

        try {
          // Use mid-point calculation for better precision with small amounts
          // Get quote for 50% of the input amount
          const halfAmountBigInt = fromAmountBigInt / 2n;
          
          if (halfAmountBigInt > 0n) {
            const halfAmountQuotes = await router.getAmountsOut(halfAmountBigInt, path);
            const halfAmountOutput = halfAmountQuotes[halfAmountQuotes.length - 1];
            
            // Double the output from half amount to get expected linear output
            const expectedOutput = halfAmountOutput * 2n;
            
            // Calculate price impact as deviation from linear expectation
            if (expectedOutput > 0n && outputAmountBigInt > 0n) {
              const impactBasisPoints = expectedOutput > outputAmountBigInt
                ? ((expectedOutput - outputAmountBigInt) * 10000n) / expectedOutput
                : ((outputAmountBigInt - expectedOutput) * 10000n) / expectedOutput;

              const impact = Number(impactBasisPoints) / 100;
              setPriceImpact(Math.max(0, Math.abs(impact))); // Ensure non-negative
            } else {
              setPriceImpact(0);
            }
          } else {
            setPriceImpact(0);
          }
        } catch (priceImpactError) {
          console.error('Price impact calculation failed:', priceImpactError);
          // Fallback to 0 impact if calculation fails
          setPriceImpact(0);
        }
      } catch (error) {
        console.error('Failed to fetch quote:', error);
        setToAmount("");
        setPriceImpact(null);
      } finally {
        setIsLoadingQuote(false);
      }
    };

    fetchQuote();

    // Set up auto-refresh interval
    const intervalId = setInterval(fetchQuote, quoteRefreshInterval * 1000);

    return () => clearInterval(intervalId);
  }, [fromAmount, fromToken, toToken, tokens, quoteRefreshInterval, contracts, chainId])

  const loadTokens = async () => {
    try {
      if (!chainId) return;

      // Filter tokens by current chain ID
      const chainTokens = getTokensByChainId(chainId);

      // Load imported tokens from localStorage (filter by chain)
      const imported = localStorage.getItem('importedTokens');
      const importedTokens: Token[] = imported ? JSON.parse(imported) : [];
      const chainImportedTokens = importedTokens.filter(t => t.chainId === chainId);

      // Add a default logoURI for missing logos, fallback to '?' if not available
      const processedTokens = chainTokens.map(token => ({
        ...token,
        logoURI: token.logoURI || `/img/logos/unknown-token.png` // Fallback logo
      }));

      const processedImportedTokens = chainImportedTokens.map(token => ({
        ...token,
        logoURI: token.logoURI || `/img/logos/unknown-token.png` // Fallback logo
      }));

      setTokens([...processedTokens, ...processedImportedTokens]);
    } catch (error) {
      console.error('Failed to load tokens:', error);
    }
  };

  const handleImportToken = async (address: string): Promise<Token | null> => {
    try {
      // Validate address format
      if (!address || address.length !== 42 || !address.startsWith('0x')) {
        throw new Error("Invalid token address format");
      }

      // Check if token already exists in default or imported tokens
      const exists = tokens.find(t => t.address.toLowerCase() === address.toLowerCase());
      if (exists) {
        toast({
          title: "Token already added",
          description: `${exists.symbol} is already in your token list`,
        });
        return exists;
      }

      // Use public RPC for token data (no wallet needed) - use chain-specific RPC
      const config = getChainConfig(chainId);
      const rpcUrl = config.rpcUrl;
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
      const contract = new Contract(address, ERC20_ABI, provider);

      // Fetch token metadata with timeout
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
        logoURI: `/img/logos/unknown-token.png`, // Fallback logo
        verified: false,
        chainId,
      };

      // Save to localStorage
      const imported = localStorage.getItem('importedTokens');
      const importedTokens: Token[] = imported ? JSON.parse(imported) : [];

      // Check if already imported
      const alreadyImported = importedTokens.find((t: Token) => t.address.toLowerCase() === address.toLowerCase());
      if (!alreadyImported) {
        importedTokens.push( newToken);
        localStorage.setItem('importedTokens', JSON.stringify(importedTokens));
      }

      // Update state
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
      } else if (error.message.includes("wallet")) {
        errorMessage = error.message;
      } else if (error.message.includes("already")) {
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

  const handleSwapTokens = () => {
    const temp = fromToken;
    setFromToken(toToken);
    setToToken(temp);
    setFromAmount(toAmount);
    setToAmount(fromAmount);
  };

  const handleWrap = async (amount: string) => {
    if (!address || !window.ethereum || !wrappedToken || !nativeToken) return;

    setIsSwapping(true);
    try {
      const provider = new BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();

      const amountBigInt = parseAmount(amount, wrappedToken.decimals);

      // For native token, we send it to wrapped contract's deposit function
      const wrappedContract = new Contract(wrappedToken.address, WRAPPED_TOKEN_ABI, signer);

      toast({
        title: "Wrapping...",
        description: `Wrapping ${amount} ${nativeSymbol} to ${wrappedSymbol}`,
      });

      // Call deposit with the amount as value (native token transfer)
      // Estimate gas and add 50% buffer
      const gasEstimate = await wrappedContract.deposit.estimateGas({ value: amountBigInt });
      const gasLimit = (gasEstimate * 150n) / 100n;
      const tx = await wrappedContract.deposit({ value: amountBigInt, gasLimit });
      const receipt = await tx.wait();

      // Refetch balances
      await Promise.all([refetchFromBalance(), refetchToBalance()]);

      setFromAmount("");
      setToAmount("");

      toast({
        title: "Wrap successful!",
        description: (
          <div className="flex items-center gap-2">
            <span>Successfully wrapped {amount} {nativeSymbol} to {wrappedSymbol}</span>
            <Button 
              size="sm" 
              variant="ghost" 
              className="h-6 px-2"
              onClick={() => openExplorer(receipt.hash)}
            >
              <ExternalLink className="h-3 w-3" />
            </Button>
          </div>
        ),
      });
    } catch (error: any) {
      console.error('Wrap error:', error);
      toast({
        title: "Wrap failed",
        description: error.reason || error.message || "Failed to wrap tokens",
        variant: "destructive",
      });
    } finally {
      setIsSwapping(false);
    }
  };

  const handleUnwrap = async (amount: string) => {
    if (!address || !window.ethereum || !wrappedToken || !nativeToken) return;

    setIsSwapping(true);
    try {
      const provider = new BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();

      const amountBigInt = parseAmount(amount, wrappedToken.decimals);
      const wrappedContract = new Contract(wrappedToken.address, WRAPPED_TOKEN_ABI, signer);

      toast({
        title: "Unwrapping...",
        description: `Unwrapping ${amount} ${wrappedSymbol} to ${nativeSymbol}`,
      });

      // Check allowance first
      const allowance = await wrappedContract.allowance(address, wrappedToken.address);

      // If allowance is insufficient, approve first
      if (allowance < amountBigInt) {
        const approveGasEstimate = await wrappedContract.approve.estimateGas(wrappedToken.address, amountBigInt);
        const approveGasLimit = (approveGasEstimate * 150n) / 100n;
        const approveTx = await wrappedContract.approve(wrappedToken.address, amountBigInt, { gasLimit: approveGasLimit });
        await approveTx.wait();
      }

      // Call withdraw with gas buffer
      const gasEstimate = await wrappedContract.withdraw.estimateGas(amountBigInt);
      const gasLimit = (gasEstimate * 150n) / 100n;
      const tx = await wrappedContract.withdraw(amountBigInt, { gasLimit });
      const receipt = await tx.wait();

      // Refetch balances
      await Promise.all([refetchFromBalance(), refetchToBalance()]);

      setFromAmount("");
      setToAmount("");

      toast({
        title: "Unwrap successful!",
        description: (
          <div className="flex items-center gap-2">
            <span>Successfully unwrapped {amount} {wrappedSymbol} to {nativeSymbol}</span>
            <Button 
              size="sm" 
              variant="ghost" 
              className="h-6 px-2"
              onClick={() => openExplorer(receipt.hash)}
            >
              <ExternalLink className="h-3 w-3" />
            </Button>
          </div>
        ),
      });
    } catch (error: any) {
      console.error('Unwrap error:', error);
      toast({
        title: "Unwrap failed",
        description: error.reason || error.message || "Failed to unwrap tokens",
        variant: "destructive",
      });
    } finally {
      setIsSwapping(false);
    }
  };

  const saveTransaction = (from: Token, to: Token, fromAmt: string, toAmt: string, txHash: string) => {
    const transaction = {
      id: txHash,
      fromToken: from,
      toToken: to,
      fromAmount: fromAmt,
      toAmount: toAmt,
      timestamp: Date.now(),
      chainId: chainId,
    };

    const storageKey = `transactions_${chainId}`;
    const existing = localStorage.getItem(storageKey);
    const transactions = existing ? JSON.parse(existing) : [];
    transactions.unshift(transaction); // Add to beginning
    
    // Keep only last 50 transactions
    if (transactions.length > 50) {
      transactions.pop();
    }
    
    localStorage.setItem(storageKey, JSON.stringify(transactions));
  };

  const handleSwap = async () => {
    if (!fromToken || !toToken || !fromAmount || parseFloat(fromAmount) <= 0) return;

    // Check if this is a wrap/unwrap operation (chain-specific)
    const config = getChainConfig(chainId);
    const isWrap = fromToken.symbol === config.nativeSymbol && toToken.symbol === config.wrappedSymbol;
    const isUnwrap = fromToken.symbol === config.wrappedSymbol && toToken.symbol === config.nativeSymbol;

    if (isWrap) {
      await handleWrap(fromAmount);
      return;
    }

    if (isUnwrap) {
      await handleUnwrap(fromAmount);
      return;
    }

    setIsSwapping(true);
    try {

      if (!address || !window.ethereum) {
        throw new Error("Please connect your wallet");
      }

      if (!contracts) {
        throw new Error("Chain contracts not configured");
      }

      const provider = new BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();

      const ROUTER_ABI = [
        "function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)",
        "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
        "function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)",
        "function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)"
      ];

      const router = new Contract(contracts.router, ROUTER_ABI, signer);
      const amountIn = parseAmount(fromAmount, fromToken.decimals);

      // Build path - use wrapped token for liquidity pool routing
      let path: string[] = [];
      const isFromNative = fromToken.address === "0x0000000000000000000000000000000000000000";
      const isToNative = toToken.address === "0x0000000000000000000000000000000000000000";

      // Get wrapped token for native conversion (already defined above)
      const wrappedAddress = wrappedToken?.address;

      if (!wrappedAddress) {
        throw new Error(`${wrappedSymbol} token not found`);
      }

      // Convert native token addresses to wrapped for pool routing
      const fromTokenAddress = isFromNative ? wrappedAddress : fromToken.address;
      const toTokenAddress = isToNative ? wrappedAddress : toToken.address;

      // Build path based on converted addresses
      if (fromTokenAddress === toTokenAddress) {
        // Same token (shouldn't happen in UI, but handle it)
        path = [fromTokenAddress, toTokenAddress];
      } else if (fromTokenAddress === wrappedAddress || toTokenAddress === wrappedAddress) {
        // Direct path if one token is wrapped
        path = [fromTokenAddress, toTokenAddress];
      } else {
        // Multi-hop through wrapped token
        path = [fromTokenAddress, wrappedAddress, toTokenAddress];
      }

      // Get expected output
      let amounts;
      try {
        amounts = await router.getAmountsOut(amountIn, path);
      } catch (error) {
        // If multi-hop fails, try direct path
        if (path.length > 2) {
          path = [fromToken.address, toToken.address];
          try {
            amounts = await router.getAmountsOut(amountIn, path);
          } catch {
            throw new Error(`No liquidity pool exists for this token pair. Try using ${wrappedSymbol} instead of ${nativeSymbol}.`);
          }
        } else {
          throw new Error(`No liquidity pool exists for this token pair. Try using ${wrappedSymbol} instead of ${nativeSymbol}.`);
        }
      }

      const amountOutMin = amounts[amounts.length - 1] * BigInt(Math.floor((100 - slippage) * 100)) / 10000n;

      // Deadline from settings
      const deadlineTimestamp = Math.floor(Date.now() / 1000) + 60 * deadline;

      // Use recipient address if provided, otherwise use connected wallet
      const recipient = recipientAddress && recipientAddress.startsWith('0x') && recipientAddress.length === 42 
        ? recipientAddress 
        : address;

      toast({
        title: "Swap initiated",
        description: `Swapping ${fromAmount} ${fromToken.symbol} for ${toToken.symbol}`,
      });

      let tx;

      if (isFromNative) {
        // Swap native USDC for tokens
        const gasEstimate = await router.swapExactETHForTokens.estimateGas(
          amountOutMin,
          path,
          recipient,
          deadlineTimestamp,
          { value: amountIn }
        );
        const gasLimit = (gasEstimate * 150n) / 100n;
        tx = await router.swapExactETHForTokens(
          amountOutMin,
          path,
          recipient,
          deadlineTimestamp,
          { value: amountIn, gasLimit }
        );
      } else if (isToNative) {
        // Swap tokens for native USDC
        // First approve router to spend tokens
        const tokenContract = new Contract(fromToken.address, ERC20_ABI, signer);
        const allowance = await tokenContract.allowance(address, ROUTER_ADDRESS);

        if (allowance < amountIn) {
          const approveGasEstimate = await tokenContract.approve.estimateGas(ROUTER_ADDRESS, amountIn);
          const approveGasLimit = (approveGasEstimate * 150n) / 100n;
          const approveTx = await tokenContract.approve(ROUTER_ADDRESS, amountIn, { gasLimit: approveGasLimit });
          const approveReceipt = await approveTx.wait();

          // Refetch balances after approval
          await Promise.all([refetchFromBalance(), refetchToBalance()]);

          toast({
            title: "Approval successful",
            description: (
              <div className="flex items-center gap-2">
                <span>Token approval confirmed</span>
                <Button 
                  size="sm" 
                  variant="ghost" 
                  className="h-6 px-2"
                  onClick={() => openExplorer(approveReceipt.hash)}
                >
                  <ExternalLink className="h-3 w-3" />
                </Button>
              </div>
            ),
          });
        }

        const gasEstimate = await router.swapExactTokensForETH.estimateGas(
          amountIn,
          amountOutMin,
          path,
          recipient,
          deadlineTimestamp
        );
        const gasLimit = (gasEstimate * 150n) / 100n;
        tx = await router.swapExactTokensForETH(
          amountIn,
          amountOutMin,
          path,
          recipient,
          deadlineTimestamp,
          { gasLimit }
        );
      } else {
        // Swap tokens for tokens
        // First approve router to spend tokens
        const tokenContract = new Contract(fromToken.address, ERC20_ABI, signer);
        const allowance = await tokenContract.allowance(address, ROUTER_ADDRESS);

        if (allowance < amountIn) {
          const approveGasEstimate = await tokenContract.approve.estimateGas(ROUTER_ADDRESS, amountIn);
          const approveGasLimit = (approveGasEstimate * 150n) / 100n;
          const approveTx = await tokenContract.approve(ROUTER_ADDRESS, amountIn, { gasLimit: approveGasLimit });
          const approveReceipt = await approveTx.wait();

          // Refetch balances after approval
          await Promise.all([refetchFromBalance(), refetchToBalance()]);

          toast({
            title: "Approval successful",
            description: (
              <div className="flex items-center gap-2">
                <span>Token approval confirmed</span>
                <Button 
                  size="sm" 
                  variant="ghost" 
                  className="h-6 px-2"
                  onClick={() => openExplorer(approveReceipt.hash)}
                >
                  <ExternalLink className="h-3 w-3" />
                </Button>
              </div>
            ),
          });
        }

        const gasEstimate = await router.swapExactTokensForTokens.estimateGas(
          amountIn,
          amountOutMin,
          path,
          recipient,
          deadlineTimestamp
        );
        const gasLimit = (gasEstimate * 150n) / 100n;
        tx = await router.swapExactTokensForTokens(
          amountIn,
          amountOutMin,
          path,
          recipient,
          deadlineTimestamp,
          { gasLimit }
        );
      }

      const receipt = await tx.wait();

      // Save transaction to history
      saveTransaction(fromToken, toToken, fromAmount, toAmount, receipt.hash);

      // Refetch balances after swap
      await Promise.all([refetchFromBalance(), refetchToBalance()]);

      setFromAmount("");
      setToAmount("");

      toast({
        title: "Swap successful!",
        description: (
          <div className="flex items-center gap-2">
            <span>Successfully swapped {fromAmount} {fromToken.symbol} for {toToken.symbol}</span>
            <Button 
              size="sm" 
              variant="ghost" 
              className="h-6 px-2"
              onClick={() => openExplorer(receipt.hash)}
            >
              <ExternalLink className="h-3 w-3" />
            </Button>
          </div>
        ),
      });
    } catch (error: any) {
      console.error('Swap error:', error);
      toast({
        title: "Swap failed",
        description: error.reason || error.message || "Failed to execute swap",
        variant: "destructive",
      });
    } finally {
      setIsSwapping(false);
    }
  };

  // Fetch balances for selected tokens with auto-refresh
  const isFromTokenNative = fromToken?.address === "0x0000000000000000000000000000000000000000";
  const isToTokenNative = toToken?.address === "0x0000000000000000000000000000000000000000";

  const { data: fromBalance, refetch: refetchFromBalance } = useBalance({
    address: address as `0x${string}` | undefined,
    ...(fromToken && !isFromTokenNative ? { token: fromToken.address as `0x${string}` } : {}),
  });

  const { data: toBalance, refetch: refetchToBalance } = useBalance({
    address: address as `0x${string}` | undefined,
    ...(toToken && !isToTokenNative ? { token: toToken.address as `0x${string}` } : {}),
  });

  // Refetch balances immediately when tokens change
  useEffect(() => {
    if (!isConnected || !fromToken || !toToken) return;

    refetchFromBalance();
    refetchToBalance();
  }, [isConnected, fromToken?.address, toToken?.address]);

  // Auto-refresh balances every 30 seconds
  useEffect(() => {
    if (!isConnected) return;

    const intervalId = setInterval(() => {
      refetchFromBalance();
      refetchToBalance();
    }, 30000); // 30 seconds

    return () => clearInterval(intervalId);
  }, [isConnected, refetchFromBalance, refetchToBalance]);

  let fromBalanceFormatted = "0.00";
  let toBalanceFormatted = "0.00";

  try {
    if (fromBalance) {
      const formatted = formatAmount(fromBalance.value, fromBalance.decimals);
      fromBalanceFormatted = formatted;
    }
  } catch (error) {
    console.error('Error formatting fromBalance', error);
  }

  try {
    if (toBalance) {
      const formatted = formatAmount(toBalance.value, toBalance.decimals);
      toBalanceFormatted = formatted;
    }
  } catch (error) {
    console.error('Error formatting toBalance', error);
  }

  // Get native and wrapped tokens based on current chain
  const chainConfig = getChainConfig(chainId);
  const nativeSymbol = chainConfig.nativeSymbol;
  const wrappedSymbol = chainConfig.wrappedSymbol;
  const nativeToken = tokens.find(t => t.symbol === nativeSymbol);
  const wrappedToken = tokens.find(t => t.symbol === wrappedSymbol);

  // Define ROUTER_ADDRESS based on chainId
  let ROUTER_ADDRESS = "";
  if (contracts) {
    ROUTER_ADDRESS = contracts.router;
  }

  return (
    <div className="container max-w-md mx-auto px-4 py-4 md:py-8 fade-in">
      <Card className="border-border/40 shadow-2xl backdrop-blur-xl bg-card/95 card-hover overflow-hidden relative">
        <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-blue-500/5 pointer-events-none"></div>
        <CardHeader className="space-y-1 pb-4 md:pb-6 relative z-10">
          <div className="flex items-center justify-between">
            <CardTitle className="text-xl md:text-2xl font-bold bg-gradient-to-r from-foreground to-foreground/80 bg-clip-text">
              Swap Tokens
            </CardTitle>
            <div className="flex items-center gap-2">
              <Button 
                data-testid="button-transaction-history"
                size="icon" 
                variant="ghost"
                onClick={() => setShowTransactionHistory(true)}
                className="h-9 w-9 hover:bg-accent/50 transition-all duration-300"
              >
                <Bell className="h-4 w-4" />
              </Button>
              <Button 
                data-testid="button-settings"
                size="icon" 
                variant="ghost"
                onClick={() => setShowSettings(true)}
                className="h-9 w-9 hover:bg-accent/50 hover:rotate-90 transition-all duration-300"
              >
                <Settings className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <p className="text-xs md:text-sm text-muted-foreground">Trade tokens instantly with the best rates</p>
        </CardHeader>

        <CardContent className="space-y-3 md:space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-muted-foreground">From</label>
              {isConnected && fromToken && (
                <span className="text-xs text-muted-foreground">
                  Balance: {fromBalanceFormatted}
                </span>
              )}
            </div>

            <div className="relative bg-gradient-to-br from-muted/50 to-muted/30 rounded-xl p-4 border border-border/40 hover:border-primary/40 transition-all duration-300 glass group">
              <Input
                data-testid="input-from-amount"
                type="number"
                placeholder="0.00"
                value={fromAmount}
                onChange={(e) => setFromAmount(e.target.value)}
                className="border-0 bg-transparent text-xl md:text-2xl font-semibold h-auto p-0 focus-visible:ring-0 focus-visible:ring-offset-0 transition-all duration-300"
              />

              <div className="flex items-center justify-between mt-3">
                <Button
                  data-testid="button-select-from-token"
                  onClick={() => setShowFromSelector(true)}
                  variant="secondary"
                  className="h-10 px-3 md:px-4 hover:bg-secondary/80 hover:scale-105 transition-all duration-300 group"
                >
                  {fromToken ? (
                    <div className="flex items-center gap-2">
                      {fromToken.logoURI ? (
                        <img 
                          src={fromToken.logoURI} 
                          alt={fromToken.symbol} 
                          className="w-6 h-6 rounded-full group-hover:scale-110 transition-transform duration-300" 
                          onError={(e) => {
                            console.error('Failed to load token logo:', fromToken.logoURI);
                            e.currentTarget.style.display = 'none';
                          }}
                        />
                      ) : (
                        <div className="w-6 h-6 rounded-full bg-red-500"></div>
                      )}
                      <span className="font-semibold text-sm md:text-base">{fromToken.symbol}</span>
                    </div>
                  ) : (
                    "Select token"
                  )}
                </Button>
                {isConnected && fromToken && fromBalance && (
                  <Button
                    data-testid="button-max-from"
                    onClick={() => setFromAmount(fromBalanceFormatted)}
                    variant="ghost"
                    size="sm"
                    className="h-8 px-3 text-xs font-semibold text-primary hover:text-primary/80 hover:bg-primary/10"
                  >
                    MAX
                  </Button>
                )}
              </div>
            </div>
          </div>

          <div className="flex justify-center -my-2 relative z-10">
            <Button
              data-testid="button-swap-direction"
              size="icon"
              variant="ghost"
              onClick={handleSwapTokens}
              disabled={!fromToken || !toToken}
              className="rounded-full h-10 w-10 bg-card border-4 border-background hover:bg-primary hover:text-primary-foreground hover:rotate-180 transition-all duration-500 shadow-lg hover:shadow-primary/50 disabled:opacity-50 pulse-glow"
            >
              <ArrowDownUp className="h-4 w-4" />
            </Button>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-muted-foreground">To</label>
              {isConnected && toToken && (
                <span className="text-xs text-muted-foreground">
                  Balance: {toBalanceFormatted}
                </span>
              )}
            </div>

            <div className="relative bg-gradient-to-br from-muted/50 to-muted/30 rounded-xl p-4 border border-border/40 hover:border-primary/40 transition-all duration-300 glass">
              <Input
                data-testid="input-to-amount"
                type="number"
                placeholder={isLoadingQuote ? "Calculating..." : "0.00"}
                value={toAmount}
                onChange={(e) => setToAmount(e.target.value)}
                className="border-0 bg-transparent text-xl md:text-2xl font-semibold h-auto p-0 focus-visible:ring-0 focus-visible:ring-offset-0"
                disabled
              />

              <div className="flex items-center justify-between mt-3">
                <Button
                  data-testid="button-select-to-token"
                  onClick={() => setShowToSelector(true)}
                  variant="secondary"
                  className="h-10 px-3 md:px-4 hover:bg-secondary/80"
                >
                  {toToken ? (
                    <div className="flex items-center gap-2">
                      {toToken.logoURI ? (
                        <img 
                          src={toToken.logoURI} 
                          alt={toToken.symbol} 
                          className="w-6 h-6 rounded-full" 
                          onError={(e) => {
                            console.error('Failed to load token logo:', toToken.logoURI);
                            e.currentTarget.style.display = 'none';
                          }}
                        />
                      ) : (
                        <div className="w-6 h-6 rounded-full bg-red-500"></div>
                      )}
                      <span className="font-semibold text-sm md:text-base">{toToken.symbol}</span>
                    </div>
                  ) : (
                    "Select token"
                  )}
                </Button>
              </div>
            </div>
          </div>

          {fromToken && toToken && fromAmount && toAmount && (
            <>
              {priceImpact !== null && priceImpact > 15 && (
                <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 space-y-2 fade-in">
                  <div className="flex items-center gap-2 text-red-500">
                    <AlertTriangle className="h-5 w-5" />
                    <span className="font-semibold text-sm">High Price Impact Warning!</span>
                  </div>
                  <p className="text-xs text-red-400">
                    This swap has a price impact of {priceImpact.toFixed(2)}%. You may receive significantly less than expected.
                  </p>
                </div>
              )}
              
              <Collapsible open={!isPriceImpactCollapsed} onOpenChange={(open) => setIsPriceImpactCollapsed(!open)}>
                <CollapsibleTrigger asChild>
                  <Button 
                    variant="ghost" 
                    className="w-full flex items-center justify-between p-3 bg-gradient-to-br from-muted/50 to-muted/30 rounded-xl border border-border/40 hover:bg-muted/60 transition-all"
                  >
                    <span className="text-sm font-medium">Trade Details</span>
                    <ChevronDown className={`h-4 w-4 transition-transform duration-200 ${!isPriceImpactCollapsed ? 'rotate-180' : ''}`} />
                  </Button>
                </CollapsibleTrigger>
                
                <CollapsibleContent className="mt-2">
                  <div className="bg-gradient-to-br from-muted/50 to-muted/30 rounded-xl p-4 space-y-3 border border-border/40 glass fade-in">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Exchange Rate</span>
                      <span className="font-medium">
                        1 {fromToken.symbol} = {(parseFloat(toAmount) / parseFloat(fromAmount)).toFixed(6)} {toToken.symbol}
                      </span>
                    </div>
                    {priceImpact !== null && (
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">Price Impact</span>
                        <span className={`font-medium flex items-center gap-1 ${
                          priceImpact > 15 ? 'text-red-500' : 
                          priceImpact > 5 ? 'text-orange-500' : 
                          priceImpact > 2 ? 'text-yellow-500' : 
                          'text-green-500'
                        }`}>
                          {priceImpact > 5 && <AlertTriangle className="h-3 w-3" />}
                          {priceImpact.toFixed(2)}%
                        </span>
                      </div>
                    )}
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Minimum Received</span>
                      <span className="font-medium">
                        {(parseFloat(toAmount) * (100 - slippage) / 100).toFixed(6)} {toToken.symbol}
                      </span>
                    </div>
                    
                    {routingPath && routingPath.length > 0 && (
                      <div className="pt-3 border-t border-border/40 mt-3 space-y-2">
                        <span className="text-xs text-muted-foreground block font-medium">Swap Route</span>
                        <div className="flex items-center justify-center gap-1.5 flex-wrap bg-muted/30 rounded-lg p-3 border border-primary/20">
                          {routingPath.map((tokenAddress, idx) => {
                            const routeToken = tokens.find(t => t.address.toLowerCase() === tokenAddress.toLowerCase());
                            return (
                              <div key={idx} className="flex items-center gap-1.5">
                                <div className="flex items-center gap-1 bg-primary/10 rounded-full px-2.5 py-1.5 hover:bg-primary/20 transition-colors">
                                  {routeToken?.logoURI ? (
                                    <img 
                                      src={routeToken.logoURI} 
                                      alt={routeToken.symbol} 
                                      className="w-5 h-5 rounded-full ring-1 ring-primary/30" 
                                      onError={(e) => e.currentTarget.style.display = 'none'}
                                    />
                                  ) : (
                                    <div className="w-5 h-5 rounded-full bg-muted flex items-center justify-center text-[10px] font-bold text-muted-foreground">?</div>
                                  )}
                                  <span className="text-xs font-semibold text-foreground">{routeToken?.symbol || '???'}</span>
                                </div>
                                {idx < routingPath.length - 1 && <ArrowRight className="h-4 w-4 text-primary/60 mx-0.5" />}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </>
          )}

          {isConnected ? (
            <Button
              data-testid="button-swap"
              onClick={handleSwap}
              disabled={!fromToken || !toToken || !fromAmount || parseFloat(fromAmount) <= 0 || isSwapping}
              className="w-full h-12 md:h-14 text-base md:text-lg font-semibold bg-gradient-to-r from-primary via-blue-500 to-blue-600 hover:from-primary/90 hover:via-blue-500/90 hover:to-blue-600/90 shadow-xl hover:shadow-2xl hover:shadow-primary/50 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-300 hover:scale-[1.02] relative overflow-hidden group"
            >
              <span className="relative z-10">{isSwapping ? "Swapping..." : "Swap"}</span>
              <span className="absolute inset-0 bg-gradient-to-r from-blue-600 to-primary opacity-0 group-hover:opacity-100 transition-opacity duration-300"></span>
            </Button>
          ) : (
            <Button
              data-testid="button-connect-wallet"
              disabled
              className="w-full h-12 md:h-14 text-base md:text-lg font-semibold"
            >
              Connect Wallet
            </Button>
          )}
        </CardContent>
      </Card>

      <TokenSelector
        open={showFromSelector}
        onClose={() => setShowFromSelector(false)}
        onSelect={(token) => {
          setFromToken(token);
          setShowFromSelector(false);
        }}
        tokens={tokens}
        onImport={handleImportToken}
      />

      <TokenSelector
        open={showToSelector}
        onClose={() => setShowToSelector(false)}
        onSelect={(token) => {
          setToToken(token);
          setShowToSelector(false);
        }}
        tokens={tokens}
        onImport={handleImportToken}
      />

      <SwapSettings
        open={showSettings}
        onClose={() => setShowSettings(false)}
        slippage={slippage}
        onSlippageChange={setSlippage}
        deadline={deadline}
        onDeadlineChange={setDeadline}
        recipientAddress={recipientAddress}
        onRecipientAddressChange={setRecipientAddress}
        quoteRefreshInterval={quoteRefreshInterval}
        onQuoteRefreshIntervalChange={setQuoteRefreshInterval}
      />

      <TransactionHistory
        open={showTransactionHistory}
        onClose={() => setShowTransactionHistory(false)}
      />
    </div>
  );
}