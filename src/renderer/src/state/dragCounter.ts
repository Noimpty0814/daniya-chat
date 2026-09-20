/** dragenter/dragleave 配对计数：跨子元素时 enter/leave 交错触发，计数归零才算真正离开 */
export class DragCounter {
  private count = 0

  enter(): void {
    this.count++
  }

  leave(): void {
    if (this.count > 0) this.count--
  }

  reset(): void {
    this.count = 0
  }

  get active(): boolean {
    return this.count > 0
  }
}
