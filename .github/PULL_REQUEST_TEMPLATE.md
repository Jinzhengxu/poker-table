<!-- Thanks for the PR. English or Chinese are both fine. -->

## What this changes

<!-- And why. If it fixes an issue, link it: Fixes #123 -->

## How it was tested

<!-- `npm test` output, the hand you reproduced, screenshots for UI changes -->

## Checklist

- [ ] `npm test` passes locally
- [ ] No new runtime dependencies (`ws` is the only one; the frontend loads nothing from the network)
- [ ] Game logic changes come with tests, using an injected deck for deterministic assertions
- [ ] No change to what hole cards a client can receive — or, if there is, it is called out above
- [ ] `SPEC.md` updated if the client/server contract changed
- [ ] UI changes still work at 360 px portrait with no horizontal scrolling
