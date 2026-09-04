module github.com/facturino/facturino-demo/go-sdk

go 1.21

require github.com/facturino/facturino-go/v2 v2.3.0

// The Facturino Go SDK is consumed from its public Git repository once it carries
// a published semantic-version tag:
//
//	go get github.com/facturino/facturino-go/v2@v2.3.0
//
// For local development against the sibling source tree (this monorepo layout),
// use an UNTRACKED go.work (see go.work.example) that `use`s ../../sdks/go — never
// a committed `replace` with a local path, which breaks `go build` for anyone who
// clones this repo.
