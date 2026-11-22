// The descriptor's CI projection: the scalar values the workflows export into
// $GITHUB_ENV and $GITHUB_OUTPUT. Nested blocks stay in the descriptor and are
// read by the CLI or jq, not flattened here.

import type { AppDescriptor } from "./app.ts";

export interface DescriptorExport {
  id: string;
  name: string;
  cask: string;
  asset_prefix: string;
  tag_prefix: string;
  source_repo: string;
  source_owner: string;
  source_dir: string;
  build_command: string;
  debloat_args: string;
  // Space-separated; "" when the app declares no build packages.
  build_packages: string;
  architectures: string;
}

export function descriptorExport(descriptor: AppDescriptor): DescriptorExport {
  return {
    id: descriptor.id,
    name: descriptor.appName,
    cask: descriptor.cask,
    asset_prefix: descriptor.assetPrefix,
    tag_prefix: descriptor.tagPrefix,
    source_repo: descriptor.sourceRepo,
    source_owner: descriptor.sourceOwner,
    source_dir: descriptor.sourceDir,
    build_command: descriptor.buildCommand,
    debloat_args: descriptor.debloatArgs,
    build_packages: descriptor.buildPackages.join(" "),
    architectures: JSON.stringify(descriptor.architectures),
  };
}

// KEY=VALUE lines for CI: `env` (uppercase) goes to $GITHUB_ENV for shell
// steps, `output` (lowercase) to $GITHUB_OUTPUT, which cannot read env.
export function descriptorLines(
  descriptor: AppDescriptor,
  format: "env" | "output" = "env",
): string[] {
  const values = descriptorExport(descriptor);
  if (format === "output") {
    return Object.entries(values).map(([key, value]) => `${key}=${value}`);
  }
  return [
    `APP_ID=${values.id}`,
    `APP_NAME=${values.name}`,
    `APP_CASK=${values.cask}`,
    `ASSET_PREFIX=${values.asset_prefix}`,
    `TAG_PREFIX=${values.tag_prefix}`,
    `SOURCE_REPO=${values.source_repo}`,
    `SOURCE_OWNER=${values.source_owner}`,
    `SOURCE_DIR=${values.source_dir}`,
    `BUILD_COMMAND=${values.build_command}`,
    `DEBLOAT_ARGS=${values.debloat_args}`,
    `BUILD_PACKAGES=${values.build_packages}`,
    `APP_ARCHITECTURES=${values.architectures}`,
  ];
}
