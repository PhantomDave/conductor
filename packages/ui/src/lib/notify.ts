import { notifications } from "@mantine/notifications";

/** Mutation `onError` handler showing a red toast with the given title and the error's message. */
export function notifyError(title: string) {
  return (error: Error) => {
    notifications.show({ color: "red", title, message: error.message });
  };
}
