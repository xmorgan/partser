export PATH := $(shell npm bin):$(PATH)

.PHONY: test
test: test.js
	standard
	node test2.js

.PHONY: publish
publish: test
	npm publish
