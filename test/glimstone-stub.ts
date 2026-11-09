// The parts of @glimstone/vue a component test renders, as plain elements:
// GlimStone's own components measure the window, which node has none of.
import { defineComponent, h } from "vue";

export const Button = defineComponent({
  props: { label: { type: String, required: true }, labelKey: { type: String, default: null } },
  setup: (props) => () => h("button", { type: "button" }, props.label),
});
