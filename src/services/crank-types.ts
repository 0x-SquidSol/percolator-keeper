/**
 * Shared types for keeper services.
 *
 * Extracted from crank.ts so adl.ts can import MarketCrankState without
 * creating a circular dependency.
 */
import type { DiscoveredMarket } from "@percolatorct/sdk";

export interface MarketCrankState {
  market: DiscoveredMarket;
  lastCrankTime: number;
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
  isActive: boolean;
  missingDiscoveryCount: number;
  permanentlySkipped?: boolean;
  permanentlySkippedAt?: number;
  skipCount?: number;
  mainnetCA?: string;
  foreignOracleSkipped?: boolean;
  hyperpNoPriceSkipped?: boolean;
  dexPoolAddress?: string;
}
