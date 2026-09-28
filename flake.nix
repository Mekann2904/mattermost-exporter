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
            echo "  bun install                                              # deps (2回目からはキャッシュで高速)"
            echo "  bun src/index.ts                                        # run TUI"
            echo "  bun x tsc --noEmit                                      # typecheck"
            echo "  bun build --compile src/index.ts --outfile dist/mattermost-exporter   # 単一バイナリ"
          '';
        };
      });
}
