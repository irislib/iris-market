package to.iris.market

import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class UpdateFlowTest {
    @get:Rule val folder = TemporaryFolder()

    private class FakeService : UpdateService {
        val checks = ArrayDeque<Result<UpdateResult>>()
        val downloads = ArrayDeque<Result<UpdateResult>>()
        var progressValues = listOf<UpdateProgress>()
        var duringDownload: () -> Unit = {}
        var downloadCount = 0
        private var current: UpdateProgress? = null
        override fun check() = checks.removeFirst().getOrThrow()
        override fun download(directory: File): UpdateResult {
            downloadCount++
            progressValues.forEach { current = it; duringDownload() }
            return downloads.removeFirst().getOrThrow()
        }
        override fun progress() = current
    }

    private val service = FakeService()
    private val steps = mutableListOf<UpdateStep>()
    private var pending: String? = null
    private var allowed = true
    private val opened = mutableListOf<File>()
    private var openFailure: Exception? = null
    private var blocker: String? = null

    private fun flow(version: String = "1.0"): UpdateFlow {
        var poll: (() -> Unit)? = null
        val flow = UpdateFlow(UpdatePlatform(
            version = version, service = { service }, downloads = { folder.root },
            installBlocker = { blocker }, mayInstall = { allowed },
            openInstaller = { file -> openFailure?.let { throw it }; opened += file },
            pending = { pending }, setPending = { pending = it },
            describe = { it.message ?: "failed" },
            background = { it() }, main = { it() },
            poll = { action -> poll = action; ({ poll = null }) },
        )) { steps += it }
        service.duringDownload = { poll?.invoke() }
        return flow
    }

    private fun result(path: String? = null) = UpdateResult(true, "2.0", path, true)
    private fun apk() = folder.newFile().path

    @Test fun installShowsEachStepUntilTheInstallerTakesOver() {
        service.checks += Result.success(result())
        service.progressValues = listOf(UpdateProgress("fetching", 0, null), UpdateProgress("downloading", 4_200_000, 19_400_000), UpdateProgress("verifying", 19_400_000, 19_400_000))
        service.downloads += Result.success(result(apk()))
        val flow = flow()
        flow.check()
        flow.install()
        assertEquals(listOf(UpdateStep.Checking, UpdateStep.Available("2.0"), UpdateStep.Fetching, UpdateStep.Downloading(4_200_000, 19_400_000),
            UpdateStep.Verifying, UpdateStep.Opening, UpdateStep.Handed("2.0")), steps.filterIndexed { i, s -> i == 0 || steps[i - 1] != s })
        assertEquals("Downloading… 4.2 MB of 19 MB", UpdateStep.Downloading(4_200_000, 19_400_000).status)
        assertEquals(4.2f / 19.4f, UpdateStep.Downloading(4_200_000, 19_400_000).fraction!!, 0.001f)
        assertEquals(1, opened.size)
        assertEquals("2.0", pending)
        assertFalse(flow.step.busy)
    }

    @Test fun failuresSayWhatHappenedAndRetryTheSameStep() {
        service.checks += Result.failure(Exception("Couldn't check for updates. Check your connection, then retry."))
        service.checks += Result.success(result())
        service.downloads += Result.failure(Exception("The download stopped. Check your connection, then retry."))
        service.downloads += Result.success(result(apk()))
        val flow = flow()
        flow.check()
        assertEquals(UpdateStep.Retry.Check, (flow.step as UpdateStep.Failed).retry)
        flow.retry()
        assertEquals(UpdateStep.Available("2.0"), flow.step)
        flow.install()
        assertEquals(UpdateStep.Failed("The download stopped. Check your connection, then retry.", UpdateStep.Retry.Install), flow.step)
        flow.retry()
        assertEquals(UpdateStep.Handed("2.0"), flow.step)
        assertEquals(2, service.downloadCount)
    }

    @Test fun closingTheInstallerWithoutUpdatingOffersRetryWithoutDownloadingAgain() {
        service.checks += Result.success(result())
        service.downloads += Result.success(result(apk()))
        val flow = flow()
        flow.check()
        flow.install()
        flow.returned()
        assertEquals(UpdateStep.Failed("The update wasn’t installed.", UpdateStep.Retry.Install), flow.step)
        assertNull(pending)
        flow.retry()
        assertEquals(UpdateStep.Handed("2.0"), flow.step)
        assertEquals(1, service.downloadCount)
        assertEquals(2, opened.size)
    }

    @Test fun permissionAndBlockedBuildsAreExplainedBeforeAnyInstall() {
        blocker = "Development builds can’t install updates. Use the released app."
        service.checks += Result.success(result())
        val flow = flow()
        flow.check()
        flow.install()
        assertEquals(UpdateStep.Failed(blocker!!, UpdateStep.Retry.Install), flow.step)
        assertEquals(0, service.downloadCount)
        blocker = null
        allowed = false
        service.downloads += Result.success(result(apk()))
        flow.retry()
        assertEquals("Allow Iris Market to install apps, then tap Retry.", (flow.step as UpdateStep.Failed).message)
        allowed = true
        openFailure = UpdateProblem("The downloaded update is missing. Retry to download it again.")
        flow.retry()
        assertEquals("The downloaded update is missing. Retry to download it again.", (flow.step as UpdateStep.Failed).message)
        assertEquals(1, service.downloadCount)
    }

    @Test fun pressesWhileBusyAreIgnored() {
        service.checks += Result.success(result())
        val flow = flow()
        flow.check()
        service.progressValues = listOf(UpdateProgress("downloading", 1, 8))
        service.duringDownload = { flow.pollProgress(); flow.check(); flow.install(); flow.retry() }
        service.downloads += Result.failure(Exception("stopped"))
        flow.install()
        assertEquals(1, service.downloadCount)
        assertEquals(1, steps.count { it == UpdateStep.Checking })
    }

    @Test fun theNextLaunchSaysWhetherTheUpdateFinished() {
        pending = "2.0"
        assertEquals(UpdateStep.Updated("2.0"), flow("2.0").step)
        assertNull(pending)
        pending = "2.0"
        assertEquals(UpdateStep.Retry.Install, (flow("1.0").step as UpdateStep.Failed).retry)
    }
}
