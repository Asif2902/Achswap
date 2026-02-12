export interface ChainContracts {
  factory: string;
  router: string;
  explorer: string;
}

// Contract addresses by chain ID - add new chain contracts here
export const contractsByChainId: Record<number, ChainContracts> = {
  5042002: {
    factory: "0x7cC023C7184810B84657D55c1943eBfF8603B72B",
    router: "0xB92428D440c335546b69138F7fAF689F5ba8D436",
    explorer: "https://testnet.arcscan.app/tx/"
  }
};

export function getContractsForChain(chainId: number): ChainContracts {
  const contracts = contractsByChainId[chainId];
  if (!contracts) {
    throw new Error(`No contracts configured for chain ID ${chainId}`);
  }
  return contracts;
}
