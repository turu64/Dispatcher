/**
 * ToggleGroupItem の選ばれている状態を、はっきり見えるようにするクラス(主色で塗る)。
 * 既定の見た目は、選ばれているものがうっすら灰色になるだけで、地図に出している時間帯が見分けにくいため。
 * hover の色(hover:bg-muted)より優先されるよう、選択中の hover も指定する。
 */
export const SELECTED_TOGGLE_CLASS =
  'data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary/90 data-[state=on]:hover:text-primary-foreground'
