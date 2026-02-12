import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { defineChain } from 'viem';

// Define ARC Testnet chain
export const arcTestnet = defineChain({
  id: 5042002,
  name: 'ARC Testnet',
  nativeCurrency: {
    decimals: 18,
    name: 'USDC',
    symbol: 'USDC',
  },
  rpcUrls: {
    default: {
      http: ['https://rpc.testnet.arc.network'],
    },
    public: {
      http: ['https://rpc.testnet.arc.network'],
    },
  },
  blockExplorers: {
    default: { name: 'ARCscan', url: 'https://testnet.arcscan.app' },
  },
  testnet: true,
});

// Supported chains array - add new chains here
export const supportedChains = [arcTestnet] as const;

export const config = getDefaultConfig({
  appName: 'Achswap',
  projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID!,
  chains: [...supportedChains],
  ssr: false,
});
