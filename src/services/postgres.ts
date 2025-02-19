// Add error boundary wrapper for queue operations
export async function safeQueueOperation<T>(
  operation: () => Promise<T>
): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    console.error("Queue operation failed:", error);
    return null;
  }
}
