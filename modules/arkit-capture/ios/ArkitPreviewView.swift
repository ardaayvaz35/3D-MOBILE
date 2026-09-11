import ExpoModulesCore
import ARKit
import SceneKit

/// Canli kamera + AR onizlemesi, uzerinde Polycam tarzi tarama agi.
///
/// Onceki surum mesh'i dolu ucgenler halinde, `.add` harmanlama ve derinlik
/// yazmadan ciziyordu. Bu uc secim birlesince tum yuzeyler ust uste toplanip
/// ekrani kaplayan tek parca mavi bir ortu gibi gorunuyordu. Simdi tel kafes
/// olarak, normal alfa harmanlamayla ve derinlik testiyle ciziliyor; boylece
/// yakin yuzeyler uzaktakileri kapatiyor ve kamera goruntusu okunur kaliyor.
class ArkitPreviewView: ExpoView, ARSCNViewDelegate {
    private let sceneView = ARSCNView()

    /// Mesh guncellemelerini kisitla. ARKit her karede onlarca mesh anchor'i
    /// guncelleyebiliyor; hepsi icin SCNGeometry yeniden kurmak tarama
    /// sirasinda belirgin takilmaya yol aciyordu.
    private static let minRebuildInterval: TimeInterval = 0.4
    private var lastRebuild: [UUID: TimeInterval] = [:]

    required init(appContext: AppContext? = nil) {
        super.init(appContext: appContext)
        sceneView.session = ArkitSessionHost.shared.session
        sceneView.automaticallyUpdatesLighting = true
        sceneView.delegate = self
        addSubview(sceneView)
        ArkitSessionHost.shared.start()
    }

    deinit {
        // Without this the shared session outlives the screen and keeps LiDAR,
        // mesh reconstruction and the camera running for the life of the app.
        releaseSession()
    }

    override func willMove(toWindow newWindow: UIWindow?) {
        super.willMove(toWindow: newWindow)
        // deinit alone is not enough: React Native can hold the view past the
        // point where it leaves the screen, and the session would keep running
        // until that reference happens to drop.
        if newWindow == nil {
            releaseSession()
        }
    }

    /// Balances the `start()` in init exactly once, whichever teardown path
    /// fires first -- a second decrement would let a live preview's session be
    /// stopped out from under it.
    private var didReleaseSession = false

    private func releaseSession() {
        guard !didReleaseSession else { return }
        didReleaseSession = true
        ArkitSessionHost.shared.stop()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        sceneView.frame = bounds
    }

    // MARK: - Overlay materyali

    /// Tel kafes materyali. Dolu yuzey yerine ag cizmek hem yuzeyin taranmis
    /// oldugunu gosteriyor hem de altindaki kamera goruntusunu kapatmiyor.
    private static let scanMaterial: SCNMaterial = {
        let m = SCNMaterial()
        m.diffuse.contents = UIColor(red: 0.25, green: 0.70, blue: 1.0, alpha: 0.9)
        m.emission.contents = UIColor(red: 0.25, green: 0.70, blue: 1.0, alpha: 0.35)
        m.fillMode = .lines
        m.isDoubleSided = true
        m.blendMode = .alpha
        m.lightingModel = .constant
        // Derinlik testi acik: yakin duvar arkadakini kapatiyor, boylece ag
        // sahnenin uzerinde yuzen bir ortu gibi degil, yuzeye yapismis gorunuyor.
        m.readsFromDepthBuffer = true
        m.writesToDepthBuffer = true
        return m
    }()

    /// ARMeshGeometry'yi cizilebilir bir SCNGeometry'ye cevirir.
    ///
    /// Onemli: ARKit'in MTLBuffer'lari yeniden kullanilip uzerine yaziliyor.
    /// Onceki surum `bytesNoCopy` ile bu bellege dogrudan bakiyordu, bu yuzden
    /// zaman zaman bozuk ucgenler ciziliyordu. Burada veriyi kopyaliyoruz.
    private func makeGeometry(from meshGeometry: ARMeshGeometry) -> SCNGeometry? {
        let vertices = meshGeometry.vertices
        let faces = meshGeometry.faces
        guard vertices.count > 0, faces.count > 0 else { return nil }

        let vertexBytes = vertices.offset + vertices.count * vertices.stride
        guard vertexBytes <= vertices.buffer.length else { return nil }
        let vertexData = Data(bytes: vertices.buffer.contents(), count: vertexBytes)

        let source = SCNGeometrySource(
            data: vertexData,
            semantic: .vertex,
            vectorCount: vertices.count,
            usesFloatComponents: true,
            componentsPerVector: 3,
            bytesPerComponent: MemoryLayout<Float>.size,
            dataOffset: vertices.offset,
            dataStride: vertices.stride
        )

        // Tum buffer uzunlugu yerine gercek indeks sayisini kullan; buffer
        // sonunda kullanilmayan alan olabiliyor ve fazlasi cop ucgen uretiyor.
        let indexBytes = faces.count * faces.indexCountPerPrimitive * faces.bytesPerIndex
        guard indexBytes <= faces.buffer.length else { return nil }
        let indexData = Data(bytes: faces.buffer.contents(), count: indexBytes)

        let element = SCNGeometryElement(
            data: indexData,
            primitiveType: .triangles,
            primitiveCount: faces.count,
            bytesPerIndex: faces.bytesPerIndex
        )

        let geometry = SCNGeometry(sources: [source], elements: [element])
        geometry.materials = [Self.scanMaterial]
        return geometry
    }

    func renderer(_ renderer: SCNSceneRenderer, nodeFor anchor: ARAnchor) -> SCNNode? {
        guard let meshAnchor = anchor as? ARMeshAnchor else { return nil }
        let node = SCNNode()
        node.geometry = makeGeometry(from: meshAnchor.geometry)
        lastRebuild[anchor.identifier] = CACurrentMediaTime()
        return node
    }

    func renderer(_ renderer: SCNSceneRenderer, didUpdate node: SCNNode, for anchor: ARAnchor) {
        guard let meshAnchor = anchor as? ARMeshAnchor else { return }
        let now = CACurrentMediaTime()
        if let last = lastRebuild[anchor.identifier], now - last < Self.minRebuildInterval {
            return
        }
        lastRebuild[anchor.identifier] = now
        if let geometry = makeGeometry(from: meshAnchor.geometry) {
            node.geometry = geometry
        }
    }

    func renderer(_ renderer: SCNSceneRenderer, didRemove node: SCNNode, for anchor: ARAnchor) {
        lastRebuild.removeValue(forKey: anchor.identifier)
    }
}
