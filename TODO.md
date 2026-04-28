# TODO

## Bugs

- [x] **`view office` not matching UI button behavior in Room Meeting** — Fixed: both `view office` and `view meeting` now click the respective nav links (`office-view-nav` / `meeting-view-nav`) in Room Meetings to trigger React Router navigation. `setViewMode()` alone only dispatches a Redux action and does not mount the target view's components, leaving a black background. Hallway Conversations fall back to `setViewMode()` since `meeting-view-nav` is absent and clicking `office-view-nav` there would exit the conversation.
