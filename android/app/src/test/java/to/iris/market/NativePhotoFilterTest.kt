package to.iris.market

import org.junit.Assert.*
import org.junit.Test

class NativePhotoFilterTest {
    @Test fun onlyUnfilteredSellingHomeDefaultsToPhotos() {
        assertFalse(NativePhotoFilter.includes(null,null,"","offer",false))
        assertTrue(NativePhotoFilter.includes("https://photos.invalid/lamp.jpg",null,"","offer",false))
        for ((query,side,map) in listOf(Triple("lamp","offer",false),Triple("","request",false),Triple("","offer",true))) {
            assertTrue(NativePhotoFilter.includes(null,null,query,side,map))
            assertFalse(NativePhotoFilter.includes(null,true,query,side,map))
        }
        assertTrue(NativePhotoFilter.includes(null,false,"","offer",false))
        assertTrue(NativePhotoFilter.wantsPhotos(null," \n","offer",false))
    }
}
