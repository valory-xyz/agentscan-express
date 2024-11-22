interface Contract {
  name: string;
  artifact: string;
  address: string;
}

interface NetworkConfig {
  name: string;
  chainId: string;
  contracts: Contract[];
}

async function fetchContractAbi(
  address: string,
  chainId: string
): Promise<any> {
  try {
    const url = `https://abidata.net/${address}?chainId=${chainId}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error(
      `Error fetching ABI for address ${address} on chain ${chainId}:`,
      error
    );
    return null;
  }
}

async function mapContractsToChains(configurations: NetworkConfig[]) {
  const contractMap = new Map<string, { chainId: string; network: string }>();

  // Build the contract mapping
  configurations.forEach((network) => {
    network.contracts.forEach((contract) => {
      contractMap.set(contract.address.toLowerCase(), {
        chainId: network.chainId,
        network: network.name,
      });
    });
  });

  return contractMap;
}

// Example usage
async function getContractAbi(
  address: string,
  configurations: NetworkConfig[]
) {
  try {
    const contractMap = await mapContractsToChains(configurations);
    const contractInfo = contractMap.get(address.toLowerCase());

    if (!contractInfo) {
      throw new Error(`Contract ${address} not found in configurations`);
    }

    const abi = await fetchContractAbi(address, contractInfo.chainId);
    return {
      abi,
      network: contractInfo.network,
      chainId: contractInfo.chainId,
    };
  } catch (error) {
    console.error("Error getting contract ABI:", error);
    return null;
  }
}
