module github.com/facturino/facturino-demo/go-sdk

go 1.21

require github.com/facturino/facturino-go v1.0.0

// The Facturino Go SDK is consumed from its public Git repository.
//
// Once the SDK repo carries a published semantic-version tag, the require
// directive above resolves over VCS with the usual `go get` command:
//
//	go get github.com/facturino/facturino-go@v1.0.0
//
// While developing against a local checkout of the SDK (this monorepo
// layout), the replace directive below points the import at the sibling
// source tree so the demo builds without a network round-trip. Remove it
// to build strictly against the tagged release.
replace github.com/facturino/facturino-go => ../../facturino-go
