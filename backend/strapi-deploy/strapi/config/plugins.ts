export default ({ env }) => ({
  // Local plugins
  'ai-writer': {
    enabled: true,
    resolve: './src/plugins/ai-writer',
    config: {
      anthropicApiKey: env('ANTHROPIC_API_KEY'),
      model: env('CLAUDE_MODEL', 'claude-sonnet-4-5-20250929'),
      maxTokens: env.int('CLAUDE_MAX_TOKENS', 4096),
    },
  },
  'bulk-import': {
    enabled: true,
    resolve: './src/plugins/bulk-import',
  },
  // Built-ins
  'users-permissions': {
    config: {
      jwtSecret: env('JWT_SECRET'),
    },
  },
});
