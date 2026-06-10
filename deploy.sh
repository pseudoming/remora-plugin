#!/bin/bash
# Remora Plugin One-Click Build and Physical Deploy Script
set -e

# 1. 执行项目构建编译
echo "🔨 Building Remora Plugin (Adapter & Core)..."
npm --prefix packages/adapter-antigravity run build

# 2. 物理隔离同步与部署
echo "🚀 Deploying physically to global plugin directory..."
node packages/adapter-antigravity/bin/install.js --force

echo "✅ Build and deployment successfully completed!"
