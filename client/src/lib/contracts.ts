export interface V2Contracts {
  factory: string;
  router: string;
}

export interface V3Contracts {
  factory: string;
  swapRouter: string;
  nonfungiblePositionManager: string;
  quoter02: string;
  migrator: string;
  positionDescriptor: string;
  tickLens: string;
}

export interface ChainContracts {
  v2: V2Contracts;
  v3: V3Contracts;
  explorer: string;
}

export const contractsByChainId: Record<number, ChainContracts> = {
  5042002: {
    v2: {
      factory: "0x7cC023C7184810B84657D55c1943eBfF8603B72B",
      router: "0xB92428D440c335546b69138F7fAF689F5ba8D436",
    },
    v3: {
      factory: "0x0f65D7c4027076144a3E07796E69CCB55aa111A2",
      swapRouter: "0x667aCD8167DC97E33f763a6d755aB8E1c6772900",
      nonfungiblePositionManager: "0xC0aA4c3b53eaE5128a70f6B24A50bcE392A75db2",
      quoter02: "0xd663bF28330f9072037E7894f5021A26FB9Cf53C",
      migrator: "0xBFC03C5C2F74080D38fb68D268dcEede423722E1",
      positionDescriptor: "0x6d413385B0383aaB3F69642c7d25dC90414f5f2c",
      tickLens: "0xC3dA3Ef175Fa0C960a8066F63BC944c8E05af873",
    },
    explorer: "https://testnet.arcscan.app/tx/"
  },
  // Add more chains here with their V2 and V3 contracts
};

export function getContractsForChain(chainId: number): ChainContracts {
  const contracts = contractsByChainId[chainId];
  if (!contracts) {
    throw new Error(`No contracts configured for chain ID ${chainId}`);
  }
  return contracts;
}
