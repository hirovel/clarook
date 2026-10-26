#!/usr/bin/env node
// 可执行入口:npx clarook / pnpm dlx。真正的分发在 cli/main.ts,编译产物在 dist/。
import("../dist/cli/main.js");
