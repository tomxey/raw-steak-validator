import { getFullnodeUrl } from '@iota/iota-sdk/client';
import { createNetworkConfig } from '@iota/dapp-kit';

const { networkConfig } = createNetworkConfig({
    mainnet: { url: getFullnodeUrl('mainnet') },
});

export { networkConfig };
