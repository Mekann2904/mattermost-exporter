{
  description = "mattermost-exporter — Mattermost channel exporter (JSON + attachments) with an OpenTUI interface";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        devShells.default = pkgs.mkShellNoCC {
          packages = [ pkgs.bun ];
          shellHook = ''
            echo "mattermost-exporter dev shell"
            echo "  bun install        # deps (2回目からはキャッシュで高速)"
            echo "  bun src/index.ts   # run TUI"
            echo "  bun test           # tests"
            echo "  bun run typecheck  # typecheck"
            echo ""
            echo "  注意: 配布用バイナリは CI がビルドする (.github/workflows/release.yml)。"
            echo "  nix の bun で bun build --compile すると /nix/store の ICU が埋め込まれ、"
            echo "  nix のない環境で dyld エラーになるため配布には使わないこと。"
          '';
        };
      });
}
