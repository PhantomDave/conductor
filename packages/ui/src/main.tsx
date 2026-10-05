import React from "react";
import ReactDOM from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { WorkspaceGate } from "./components/WorkspaceGate";
import { conductorTheme } from "./theme";

import "@mantine/core/styles.css";
import "@mantine/charts/styles.css";
import "@mantine/notifications/styles.css";
import "./global.css";

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MantineProvider theme={conductorTheme} defaultColorScheme="dark">
      <Notifications position="top-right" autoClose={4000} pauseResetOnHover="notification" />
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <WorkspaceGate>
            <App />
          </WorkspaceGate>
        </QueryClientProvider>
      </ErrorBoundary>
    </MantineProvider>
  </React.StrictMode>,
);
