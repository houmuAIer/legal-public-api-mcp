export interface Env {
  MCP_AUTH_TOKEN?: string;
  HOUJIN_APP_ID?: string;
  HOUJIN_API_BASE: string;
  EGOV_API_BASE: string;
  KOKKAI_API_BASE: string;
  /** ローカル開発専用。"true" のときだけ認証なしで受け付ける */
  ALLOW_NO_AUTH?: string;
}
