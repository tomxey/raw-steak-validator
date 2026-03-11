import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@iota/dapp-kit/dist/index.css';

import { IotaClientProvider, WalletProvider } from '@iota/dapp-kit';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { networkConfig } from './networkConfig';
import App from './App';

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <QueryClientProvider client={queryClient}>
            <IotaClientProvider networks={networkConfig} defaultNetwork="mainnet">
                <WalletProvider autoConnect>
                    <BrowserRouter>
                        <App />
                    </BrowserRouter>
                </WalletProvider>
            </IotaClientProvider>
        </QueryClientProvider>
    </React.StrictMode>,
);
