import { StyleSheet, View } from "react-native";
import { Icon } from "./Icon";
import { useTheme } from "./theme";

/**
 * A check box that is a task's state: a Markdown task (`- [ ]` open, `- [x]` done) in a page or a message, the phone's
 * twin of the web's `.md__task-box`, and a task's acceptance criterion. Ink: blue is the agents' color, and a fixed
 * white broke on dark.
 * With `ink` (words over a solid bubble, whose color it doesn't know) the box and its check are drawn in that ink,
 * never filled. Who wraps it says what it is to a screen reader and whether a tap checks it.
 */
export function TaskBox({ done, size = 20, ink }: { done: boolean; size?: number; ink?: string | undefined }) {
  const { colors } = useTheme();
  const look = ink
    ? { borderWidth: 1.5, borderColor: ink }
    : done
      ? { backgroundColor: colors.ink }
      : { borderWidth: 1.5, borderColor: colors.line2 };
  return (
    <View style={[styles.box, { width: size, height: size, borderRadius: Math.round(size * 0.3) }, look]}>
      {done ? <Icon name="check" size={Math.round(size * 0.65)} color={ink ?? colors.bg} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: "center", justifyContent: "center" },
});
