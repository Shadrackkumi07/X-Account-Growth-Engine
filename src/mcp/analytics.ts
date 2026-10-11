import type { ConnectionService } from "../services/connectionService.js";
import { analyticsResponse } from "../services/actionAnalytics.js";
import { ApiError } from "../lib/errors.js";

export const MCP_ACCOUNTS = {
  get_bloomquest_analytics: { name: "BloomQuest: Celebrate", id: "2077627663540535296" },
  get_serionflow_analytics: { name: "SerionFlow", id: "2041559051490783232" },
} as const;
export const MAX_RESPONSE_BYTES = 96 * 1024;

type Analytics = Awaited<ReturnType<typeof analyticsResponse>>;
type Post = Analytics["posts"][number];

function compactPost(post: Post) {
  const {
    account_id: _account,
    first_seen_at: _first,
    updated_at: _updated,
    conversation_id: _conversation,
    possibly_sensitive: _sensitive,
    mentions: _mentions,
    performance_relative_to_recent_average,
    metrics,
    ...content
  } = post;
  if (!metrics) return { ...content, metrics: null, performance_relative_to_recent_average };
  const {
    account_id: _metricAccount,
    post_id: _post,
    age_seconds: _age,
    user_profile_clicks: _duplicate,
    ...safeMetrics
  } = metrics;
  return { ...content, metrics: safeMetrics, performance_relative_to_recent_average };
}

export async function mcpAnalytics(service: ConnectionService, accountId: string, days: number) {
  const data = await analyticsResponse(service, accountId, days, accountId);
  const summaries = [data.summary_7d, data.summary_30d];
  const allPosts = [
    ...data.posts,
    ...summaries.flatMap((s) => [...s.best_posts, ...s.worst_posts]),
  ];
  if (
    data.account.id !== accountId ||
    data.analytics_history.some((s) => s.account_id !== accountId) ||
    allPosts.some(
      (p) => p.account_id !== accountId || (p.metrics && p.metrics.account_id !== accountId),
    )
  ) {
    throw new ApiError(
      409,
      "account_mismatch",
      "Analytics account identity did not match the requested company.",
    );
  }
  const deduped = new Map<string, Post>();
  for (const post of data.posts) {
    const previous = deduped.get(post.post_id);
    if (
      !previous ||
      Date.parse(post.metrics?.captured_at ?? post.updated_at) >
        Date.parse(previous.metrics?.captured_at ?? previous.updated_at)
    )
      deduped.set(post.post_id, post);
  }
  const recent = [...deduped.values()].sort((a, b) =>
    (b.created_at ?? "").localeCompare(a.created_at ?? ""),
  );
  const originals = recent.filter((p) => p.kind === "original" || p.kind === "quote");
  const replies = recent.filter((p) => p.kind === "reply");
  const reposts = recent.filter((p) => p.kind === "retweet");
  const compactSummary = (summary: Analytics["summary_7d"]) => {
    const { best_posts, worst_posts, ...aggregates } = summary;
    return {
      ...aggregates,
      best_post_ids: best_posts.map((p) => p.post_id),
      worst_post_ids: worst_posts.map((p) => p.post_id),
    };
  };
  const result = {
    account: data.account,
    days,
    generated_at: data.generated_at,
    analytics_history: data.analytics_history.slice(-90).map(({ account_id: _id, ...s }) => s),
    summary_7d: compactSummary(data.summary_7d),
    summary_30d: compactSummary(data.summary_30d),
    original_posts: originals.slice(0, 120).map(compactPost),
    replies: replies.slice(0, 60).map(compactPost),
    reposts: reposts.slice(0, 20).map(compactPost),
    coverage: {
      available_posts: recent.length,
      returned_posts: 0,
      omitted_posts: 0,
      available_originals_and_quotes: originals.length,
      available_replies: replies.length,
      available_reposts: reposts.length,
      available_account_snapshots: data.analytics_history.length,
      omitted_account_snapshots: 0,
      truncated: false,
      note: "Summaries use all stored posts available to the existing analytics service. Post lists are bounded and newest first; data collection may not cover every day requested. Best/worst IDs may refer to omitted posts.",
    },
  };
  const updateCoverage = () => {
    result.coverage.returned_posts =
      result.original_posts.length + result.replies.length + result.reposts.length;
    result.coverage.omitted_posts = recent.length - result.coverage.returned_posts;
    result.coverage.omitted_account_snapshots =
      data.analytics_history.length - result.analytics_history.length;
    result.coverage.truncated =
      result.coverage.omitted_posts > 0 || result.coverage.omitted_account_snapshots > 0;
  };
  updateCoverage();
  while (Buffer.byteLength(JSON.stringify(result)) > MAX_RESPONSE_BYTES) {
    // Preserve more original content while reducing the bounded lists further.
    if (result.reposts.length) result.reposts.pop();
    else if (result.replies.length) result.replies.pop();
    else if (result.original_posts.length) result.original_posts.pop();
    else if (result.analytics_history.length) result.analytics_history.shift();
    else
      throw new ApiError(
        502,
        "upstream_error",
        "Analytics summaries exceed the MCP response limit.",
      );
    updateCoverage();
  }
  return result;
}
