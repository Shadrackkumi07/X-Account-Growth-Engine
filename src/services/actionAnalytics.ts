import type { ConnectionService } from "./connectionService.js";
import { ApiError } from "../lib/errors.js";

export async function analyticsResponse(
  connectionService: ConnectionService,
  account: string,
  days: number,
  expectedAccountId?: string,
) {
  const accountHistory = await connectionService.accountAnalytics(account, days);
  const posts = await connectionService.posts(account, days);
  const summary7d = await connectionService.summary(account, 7);
  const summary30d = await connectionService.summary(account, 30);
  if (
    expectedAccountId &&
    [accountHistory, posts, summary7d, summary30d].some(
      (payload) => payload.account.x_account_id !== expectedAccountId,
    )
  )
    throw new ApiError(409, "account_mismatch", "Analytics account identity validation failed.");
  const current = accountHistory.current;
  const { account: _summary7dAccount, ...safeSummary7d } = summary7d;
  const { account: _summary30dAccount, ...safeSummary30d } = summary30d;

  return {
    account: {
      id: accountHistory.account.x_account_id,
      handle: accountHistory.account.username,
      display_name: accountHistory.account.display_name,
      followers: current?.followers ?? null,
      following: current?.following ?? null,
      total_posts: current?.total_posts ?? null,
      current_timestamp: current?.captured_at ?? null,
    },
    analytics_history: accountHistory.history,
    posts: posts.posts,
    summary_7d: safeSummary7d,
    summary_30d: safeSummary30d,
    generated_at: new Date().toISOString(),
  };
}
