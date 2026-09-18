export interface PingResult {
  success: boolean;
  latency: number | null;
  message: string;
}
export function ping(ip: string): Promise<PingResult>;
