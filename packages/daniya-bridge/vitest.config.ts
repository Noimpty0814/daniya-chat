import { defineConfig } from 'vitest/config'

// 包级测试只收 tests/**/*.spec.ts；屏蔽仓库根 vitest.config 的 src/** 约定。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
  },
})
